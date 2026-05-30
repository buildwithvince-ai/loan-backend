#!/usr/bin/env bash
# Scaffold the next numbered migration in migrations/ matching repo convention.
# Usage: scaffold.sh "add foo column to applications"
set -eu

root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
dir="$root/migrations"
mkdir -p "$dir"

desc_raw="${*:-}"
if [ -z "$desc_raw" ]; then
  echo "ERROR: pass a description, e.g. scaffold.sh \"add foo column\"" >&2
  exit 1
fi

# next number = highest existing NNN_ + 1, zero-padded to 3
last=$(ls "$dir" 2>/dev/null | grep -Eo '^[0-9]{3}' | sort -n | tail -1)
if [ -z "${last:-}" ]; then next=1; else next=$((10#$last + 1)); fi
num=$(printf '%03d' "$next")

# slug: lowercase, non-alnum -> _, squeeze, trim
slug=$(printf '%s' "$desc_raw" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/_/g; s/^_+//; s/_+$//')

file="$dir/${num}_${slug}.sql"
if [ -e "$file" ]; then echo "ERROR: $file already exists" >&2; exit 1; fi

cat > "$file" <<EOF
-- Migration: ${num}_${slug}
-- ${desc_raw}
--
-- TODO: explain what this changes and why. Apply by hand in Supabase SQL Editor.
-- Idempotent so it is safe to re-run.

-- TODO: write idempotent DDL. Examples (match style of existing migrations):
-- alter table applications add column if not exists my_col text;
-- comment on column applications.my_col is 'what it stores';
EOF

echo "Created $file"
