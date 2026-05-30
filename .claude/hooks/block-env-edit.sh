#!/usr/bin/env bash
# PreToolUse(Edit|Write|MultiEdit): block edits to secret env files.
# Reads hook JSON on stdin, blocks (exit 2) when target is a .env file.
set -euo pipefail

input=$(cat)
fp=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')

case "$fp" in
  *.env | *.env.* )
    echo "BLOCKED: refusing to write secrets file ($fp). Holds SUPABASE_SERVICE_KEY / Loandisk / ZeptoMail / CI_SECRET. Edit by hand if truly intended." >&2
    exit 2
    ;;
esac

exit 0
