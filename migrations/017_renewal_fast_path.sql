-- Migration: 017_renewal_fast_path
-- Server-derived renewal detection + FinScore attribution (2026-08-04).
--
-- Renewal status was previously whatever the frontend put in
-- `application_category` / `linked_borrower_id`. It is now derived server-side
-- from the applicant's own prior applications (see services/renewal.js); those
-- two columns keep their meaning and stay the storage for renewal state — no
-- second `is_renewal` flag, which would only be a duplicate of
-- application_category.
--
-- New columns record the provenance of an attributed score so an approver can
-- see the composite was inherited rather than freshly measured:
--   renewal_source_application_id — the prior approved application the renewal
--     links to. Set whenever a renewal is detected, even when the FinScore
--     fast-path does not apply (borrower reuse and score reuse are separate).
--   finscore_attributed — true when the FinScore call was skipped and
--     finscore_raw / finscore_normalized were copied from the source row.
--   attributed_final_score — the source row's composite at the time of copy.
--     Audit trail only; the live composite is still recomputed at CI stage.
--
-- idx_applications_phone_approved backs the new eligibility lookup on /submit
-- (phone = ? and status = 'approved' order by submitted_at desc limit 1).
-- The existing idx_applications_phone is a plain phone index, so the approved
-- filter and the sort both fall back to a heap scan without this one.
--
-- Apply by hand in the Supabase SQL Editor (no migration runner).
-- Non-breaking: `if not exists` throughout, no data changes, no backfill —
-- existing rows read as finscore_attributed = false, which is correct.

alter table applications add column if not exists renewal_source_application_id uuid;
alter table applications add column if not exists finscore_attributed boolean not null default false;
alter table applications add column if not exists attributed_final_score numeric(5,1);

create index if not exists idx_applications_phone_approved
  on applications (phone, submitted_at desc)
  where status = 'approved';
