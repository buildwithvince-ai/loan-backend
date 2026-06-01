-- Migration: 010_manual_override
-- Approver manual-override for applications with no FinScore.
--
-- Background: when finscore_raw is null/0, the composite score treats FinScore
-- as 0, which can push an otherwise-fundable applicant below the decline
-- threshold purely for lack of a credit signal. This lets an approver (or
-- admin/super_admin) manually push such an application back into the approver
-- stage with a documented reason. Override is NOT a low-score escape hatch:
-- the route rejects it when a valid FinScore is present.
--
-- All columns idempotent. Applied via Supabase MCP against prod before the
-- /override route deploys (Railway auto-deploys from main).

alter table applications
  add column if not exists manual_override boolean not null default false,
  add column if not exists override_reason text,
  add column if not exists overridden_by uuid references admin_users(id),
  add column if not exists overridden_at timestamptz;
