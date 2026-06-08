-- Migration: 014_security_constraints
-- Security-audit (2026-06-08) Tier 2/3 schema changes.
--
-- H7 — duplicate-application guard is non-atomic. A partial unique index on
--   phone (only for status='pending') makes a concurrent double-submit fail at
--   the DB instead of creating two apps + double FinScore charges. The submit
--   route catches the unique violation (Postgres 23505) and returns the generic
--   "already under review" ack.
--
-- H3 — failed file uploads were silently dropped, leaving an app persisted with
--   missing KYC docs. `documents_incomplete` flags those rows so the pipeline /
--   dashboard can surface them (and block advance) instead of pushing an
--   incomplete record to Loandisk.
--
-- Apply by hand in the Supabase SQL Editor (no migration runner).
--
-- NOTE (H7): if any duplicate pending rows already exist, the index creation
-- will fail. Dedupe first, e.g.:
--   delete from applications a using applications b
--   where a.status='pending' and b.status='pending'
--     and a.phone=b.phone and a.ctid < b.ctid;
-- (Review before running — this keeps the newest pending row per phone.)

create unique index if not exists applications_pending_phone_uniq
  on applications (phone)
  where status = 'pending';

alter table applications
  add column if not exists documents_incomplete boolean not null default false;

-- H10/H11 — concurrent approval → duplicate Loandisk loans (TOCTOU). The
-- Loandisk push (executeLoandiskApproval) claims this column with an atomic
-- conditional update (set ... where loan_push_claimed_at is null) BEFORE doing
-- any side effect, so only one of N concurrent approvals proceeds. It is reset
-- to null if the push fails, so a later retry can re-claim.
alter table applications
  add column if not exists loan_push_claimed_at timestamptz;
