---
name: preflight
description: Run a smoke check before pushing the loan backend to main (push auto-deploys production, and there is no test suite). Verifies all source files parse, every route/service/middleware module loads without throwing, and required env vars are present. Use before any git push to main, or when asked to validate the app boots.
disable-model-invocation: true
---

# preflight

There is **no test suite** and pushing to `main` **auto-deploys to production** (Railway). This skill is the minimal safety gate to run before a push.

## Run it

```bash
"$CLAUDE_PROJECT_DIR/.claude/skills/preflight/check.sh"
```

## What it checks

1. **Syntax** — `node --check` on `index.js` and every file under `routes/`, `services/`, `middleware/`.
2. **Module load** — requires each route/service/middleware module with dummy env vars to catch load-time errors (bad imports, top-level throws). Does **not** require `index.js` (it would start the listener).
3. **Env vars** — confirms required variable **names** exist in `.env` (per `CLAUDE.md`). Never prints values.

Exit code is non-zero on any failure; the final line is `PREFLIGHT: PASS` or `PREFLIGHT: FAIL`.

## After it passes

A green preflight only proves the app loads and config is wired — it does **not** test behavior. For anything touching auth, money math (scoring/tiers), or external pushes (Loandisk/FinScore/ZeptoMail), still reason through the change and consider running the `security-reviewer` agent before pushing.
