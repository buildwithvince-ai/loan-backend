#!/usr/bin/env bash
# Preflight smoke check for the loan backend.
# No test suite + push-to-main auto-deploys prod, so this is the minimal gate.
# Checks: (1) JS syntax on all source, (2) every route/service/middleware module
# loads without throwing, (3) required env var NAMES are present in .env.
# Exits non-zero if anything fails. Never prints secret values.
set -u

root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$root" || exit 1
fail=0

echo "== 1. syntax check =="
while IFS= read -r f; do
  if node --check "$f" 2>/tmp/preflight_syn.err; then
    :
  else
    echo "  SYNTAX FAIL: $f"; cat /tmp/preflight_syn.err; fail=1
  fi
done < <(find . -path ./node_modules -prune -o -name '*.js' -print | grep -E '^\./(index\.js|routes/|services/|middleware/)')
[ "$fail" -eq 0 ] && echo "  ok"

echo "== 2. module load check =="
# Load routes/services/middleware with dummy env. Do NOT require index.js (it listens).
export SUPABASE_URL="http://localhost"
export SUPABASE_SERVICE_KEY="dummy"
node -e '
  const fs = require("fs");
  const dirs = ["routes", "services", "middleware"];
  let bad = 0;
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d).filter(x => x.endsWith(".js"))) {
      const p = "./" + d + "/" + f;
      try { require(p); }
      catch (e) { console.log("  LOAD FAIL: " + p + " -> " + e.message); bad++; }
    }
  }
  if (bad) process.exit(1);
  console.log("  ok");
' || fail=1

echo "== 3. env var coverage (WARN only) =="
# Derive the required set from what the code actually reads (process.env.X),
# not a hardcoded list that drifts. Local .env may legitimately lack prod-only
# vars (those live in Railway), so a gap here is a WARNING, never a hard fail.
if [ ! -f .env ]; then
  echo "  WARN: no .env file found (ok if vars come from the environment / Railway)"
else
  used=$(grep -rhoE 'process\.env\.[A-Z_][A-Z0-9_]*' index.js routes services middleware 2>/dev/null \
         | sed 's/process\.env\.//' | sort -u)
  missing=0
  for v in $used; do
    # PORT has a documented default; skip it
    [ "$v" = "PORT" ] && continue
    if grep -Eq "^[[:space:]]*${v}=" .env; then :; else echo "  WARN: $v read by code but not set in .env"; missing=1; fi
  done
  [ "$missing" -eq 0 ] && echo "  ok"
fi

echo
if [ "$fail" -eq 0 ]; then echo "PREFLIGHT: PASS"; else echo "PREFLIGHT: FAIL"; fi
exit "$fail"
