-- Migration: 015_atomic_stage_history
-- Security-audit (2026-06-08) M6 — stage_history concurrent updates clobber
-- each other (lost update). The old pattern read stage_history into JS, appended
-- in memory, then wrote the whole array back. Two concurrent transitions =
-- last-writer-wins, losing audit entries in a regulated-lending flow.
--
-- These RPCs append/increment server-side in a single atomic statement using
-- Postgres `jsonb ||`, so concurrent callers can't lose each other's writes.
--
-- Apply by hand in the Supabase SQL Editor (no migration runner).

-- Atomic stage transition: set the new stage, append one history entry, and
-- optionally stamp the SO decision — all in one UPDATE. Returns the full row so
-- callers keep the same shape they had from .update().select().single().
create or replace function apply_stage_transition(
  p_id uuid,
  p_to_stage text,
  p_entry jsonb,
  p_so_decision text default null,
  p_so_decision_at timestamptz default null
)
returns applications
language sql
as $$
  update applications
  set stage          = p_to_stage,
      stage_history  = coalesce(stage_history, '[]'::jsonb) || p_entry,
      so_decision    = coalesce(p_so_decision, so_decision),
      so_decision_at = coalesce(p_so_decision_at, so_decision_at)
  where id = p_id
  returning *;
$$;

-- Atomic rework-return bookkeeping: bump the counter with a SQL expression
-- (no read-modify-write) and record the latest reason/timestamp.
create or replace function bump_returned_count(
  p_id uuid,
  p_reason text
)
returns applications
language sql
as $$
  update applications
  set returned_count   = coalesce(returned_count, 0) + 1,
      last_return_reason = p_reason,
      last_returned_at = now()
  where id = p_id
  returning *;
$$;
