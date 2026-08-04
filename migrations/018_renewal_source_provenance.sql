-- 018 — renewal score provenance
--
-- An attributed row copies finscore_raw / finscore_normalized from its source
-- application (see 017), so the score is byte-identical to one measured today.
-- finscore_attributed is the only field distinguishing them, which puts the
-- entire signal on a separate UI element from the number it qualifies — the
-- approver screen renders a possibly-89-day-old score as a bare value.
--
-- These two columns let the age travel with the number itself:
--   "555 · carried over, measured 12 Jun 2026 (GR8-1780422)"
--
-- renewal_source_application_id (017) already points at the source row, but it
-- is a UUID: unrenderable for staff, and resolving it costs a second lookup on
-- the one screen that must not be slow.
--
-- DEPLOY GATE: /submit writes both columns on EVERY submission, not just
-- renewals. Apply this BEFORE shipping the code or the public intake endpoint
-- fails outright. Same failure mode as the 2026-06-03 incident.

alter table applications add column if not exists renewal_source_submitted_at timestamptz;
alter table applications add column if not exists renewal_source_reference_id text;

-- Backfill the rows written between 017 and 018 so existing renewals render
-- provenance too, instead of showing a carried-over score with no age.
update applications a
set renewal_source_submitted_at = s.submitted_at,
    renewal_source_reference_id = s.reference_id
from applications s
where a.renewal_source_application_id = s.id
  and a.renewal_source_submitted_at is null;

-- Refresh the PostgREST schema cache — without this the columns exist in
-- Postgres but supabase-js still rejects them ("Could not find the column in
-- the schema cache").
notify pgrst, 'reload schema';
