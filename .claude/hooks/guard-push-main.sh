#!/usr/bin/env bash
# PreToolUse(Bash): WARN (non-blocking) on any `git push` that targets main.
# Push to main auto-deploys PRODUCTION on Railway with no test gate.
# Warn-only: prints a reminder to stderr but exits 0 so the push proceeds.
# (User runs rapid commit-and-push cycles; a hard block was too much friction.)
set -uo pipefail

input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty')

if printf '%s' "$cmd" | grep -Eq 'git[[:space:]]+push' \
   && printf '%s' "$cmd" | grep -Eq '(^|[^a-zA-Z0-9_])main([^a-zA-Z0-9_]|$)'; then
  echo "REMINDER: this pushes to main -> auto-deploys PRODUCTION (Railway), no test gate. Consider running the preflight skill + security-reviewer first." >&2
fi

exit 0
