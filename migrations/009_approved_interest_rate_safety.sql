-- Migration: 009_approved_interest_rate_safety
-- Safety net for missing approved_interest_rate column.
--
-- Background: migration 007 declared approved_interest_rate numeric(5,2),
-- but production approvals were observed failing with "column does not
-- exist". This idempotent ALTER adds the column if 007 was never applied
-- (or applied partially). Uses unqualified numeric so the cast still
-- accepts the values pipeline.js writes (3.5, 3.0, 4.0, 5.0).
--
-- If you see this column missing in prod, the rest of migration 007
-- (discount_reason, payment_scheme_id, fee columns, loandisk_loan_id,
-- loan_released_at) is also likely missing — apply 007 in full first.

alter table applications add column if not exists approved_interest_rate numeric;
