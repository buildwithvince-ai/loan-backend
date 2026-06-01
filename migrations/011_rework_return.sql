-- Migration: 011_rework_return
-- Verifier "return for rework" loop.
--
-- Background: a verifier reviewing an application sometimes needs more client
-- info or a missing requirement, so they bounce it back to the sales officer.
-- The SO completes it and re-endorses, which routes BACK to the verifier for a
-- re-check. This is distinct from "Request SO Confirmation" (client go-ahead →
-- approver) — that flow uses so_confirmation_sent_at and is unaffected.
--
-- returned_count already exists (migration 005) and now counts only rework
-- returns. These columns surface the latest return reason to the SO so they
-- know what to fix without digging through stage_history.

alter table applications
  add column if not exists last_return_reason text,
  add column if not exists last_returned_at timestamptz;
