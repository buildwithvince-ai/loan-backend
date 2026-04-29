-- Migration: 007_loan_creation_fields
-- Adds columns for Loandisk loan-creation flow per BLOCKER.md.
-- Captures approved rate (incl. discount overrides), payment scheme, fees,
-- and the resulting Loandisk loan id for reconciliation.

alter table applications add column if not exists approved_interest_rate numeric(5,2);
alter table applications add column if not exists discount_reason text;
alter table applications add column if not exists payment_scheme_id integer;
alter table applications add column if not exists num_of_repayments integer;
alter table applications add column if not exists service_fee_amount numeric(12,2);
alter table applications add column if not exists insurance_fee_amount numeric(12,2);
alter table applications add column if not exists total_fees_amount numeric(12,2);
alter table applications add column if not exists net_disbursement_amount numeric(12,2);
alter table applications add column if not exists total_interest_amount numeric(12,2);
alter table applications add column if not exists loandisk_loan_id text;
alter table applications add column if not exists loan_released_at timestamptz;

create index if not exists idx_applications_loandisk_loan_id on applications (loandisk_loan_id);
