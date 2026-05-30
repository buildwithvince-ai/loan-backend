---
name: create-migration
description: Scaffold a new numbered SQL migration for the loan backend (migrations/NNN_*.sql), matching repo convention, and guide applying it. There is no migration runner — migrations are applied by hand in the Supabase SQL Editor. Use when adding a column, table, index, or any schema change.
disable-model-invocation: true
---

# create-migration

This project has **no migration runner**. Migrations are plain SQL files in `migrations/`, numbered `NNN_snake_case.sql` (3-digit, sequential — latest is `009`), and applied **by hand in the Supabase SQL Editor**. This skill scaffolds the next file matching that convention.

## Steps

1. **Scaffold the file** — run the bundled script with a short description:
   ```bash
   "$CLAUDE_PROJECT_DIR/.claude/skills/create-migration/scaffold.sh" "add credit_limit column to applications"
   ```
   It auto-computes the next number (e.g. `010`), slugifies the description, and writes a template with TODO markers.

2. **Fill in the DDL** — edit the generated file. Rules:
   - **Idempotent always**: `add column if not exists`, `create table if not exists`, `create index if not exists`. The file may be re-run.
   - Replace the TODO lines (header explanation + the DDL body).
   - Add `comment on column <table>.<col> is '...';` documenting any new column.
   - Lowercase SQL keywords — match existing `migrations/00*.sql`.

3. **Note rollback** — add a comment showing how to undo (e.g. `-- rollback: alter table applications drop column credit_limit;`). There is no automated rollback.

4. **Apply manually** — the file is NOT auto-applied. Tell the user to:
   - Open Supabase → SQL Editor
   - Paste the migration contents and run it
   - (If the Supabase MCP is configured and writable, you may apply it via MCP only after the user confirms.)

5. **Record apply state** — after the user confirms it ran in prod, append a line to `.claude/memory.md` noting the migration number + date applied. The project tracks apply state there since there is no runner.

## Convention reference (from existing migrations)

```sql
-- Migration: 009_approved_interest_rate_safety
-- Safety net for missing approved_interest_rate column.
-- Idempotent so it is safe to re-run.

alter table applications add column if not exists approved_interest_rate numeric;
```

Tables: `applications`, `admin_users`. Full schema in `CLAUDE.md`.
