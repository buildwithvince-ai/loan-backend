-- Migration: 012_repayment_schedule_fields
-- Adds CI-stage repayment scheduling fields + approver loan release date.
--   payment_frequency     : 'one_time' | 'two_times' (CI stage)
--   salary_payout_dates   : 1 or 2 day-of-month integers (1-31), CI stage
--   repayment_cycle       : frontend-generated string e.g. '15' or '15-30'
--   loan_release_date     : approver-supplied release date (required at approval)
--   first_repayment_date  : computed from release date + cycle, mapped to Loandisk
-- Apply by hand in the Supabase SQL Editor (no migration runner).

alter table applications add column if not exists payment_frequency text;
alter table applications add column if not exists salary_payout_dates integer[];
alter table applications add column if not exists repayment_cycle text;
alter table applications add column if not exists loan_release_date date;
alter table applications add column if not exists first_repayment_date date;
