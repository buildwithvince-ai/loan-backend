-- Migration: 013_sbl_honorarium_date
-- Adds the SBL honorarium date captured at the CI stage.
--   honorarium_date : day-of-month integer (1-31) the applicant receives their
--                     honorarium. Required for SBL at CI scoring; the SBL first
--                     repayment follows this date (release + 15d -> honorarium).
--                     Null for non-SBL products.
-- Apply by hand in the Supabase SQL Editor (no migration runner).

alter table applications add column if not exists honorarium_date integer;
