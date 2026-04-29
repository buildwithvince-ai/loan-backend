-- Migration: 008_renewal_and_sa_confirmation
-- Adds:
--   - Issue 1: renewal flow columns (application_category, linked_borrower_id)
--   - Issue 3: approver-modified-terms + SA confirmation loop columns
--
-- Status values now in use:
--   pending, pending_sa_confirmation, approved, declined
-- (kept as free text — no enum constraint to add.)

alter table applications add column if not exists application_category text default 'new';
alter table applications add column if not exists linked_borrower_id text;

alter table applications add column if not exists approver_proposed_amount numeric(12,2);
alter table applications add column if not exists approver_proposed_term integer;
alter table applications add column if not exists approver_proposed_at timestamptz;
alter table applications add column if not exists approver_proposed_by uuid;

alter table applications add column if not exists sa_rejection_note text;
alter table applications add column if not exists sa_rejection_at timestamptz;
alter table applications add column if not exists sa_rejection_by uuid;

create index if not exists idx_applications_status on applications (status);
create index if not exists idx_applications_linked_borrower on applications (linked_borrower_id);
create index if not exists idx_applications_full_name_lower on applications (lower(full_name));
create index if not exists idx_applications_phone on applications (phone);
