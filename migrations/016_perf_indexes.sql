-- Migration: 016_perf_indexes
-- Backend optimization review (2026-07-06) — findings 4.
--
-- idx_applications_submitted_at: the admin list, CI list, and prior-decline
--   lookup all ORDER BY submitted_at; without an index every list load sorts
--   the full table.
-- idx_applications_loandisk_borrower_id: the renewal linked_borrower_id
--   validation on /submit (eq lookup) and the borrower search filter
--   (is not null) both hit this column; partial index keeps it small since
--   only approved rows have a borrower id.
--
-- Apply by hand in the Supabase SQL Editor (no migration runner).
-- Non-breaking: `if not exists`, no data changes, table is small enough that
-- the build lock is momentary.

create index if not exists idx_applications_submitted_at
  on applications (submitted_at desc);

create index if not exists idx_applications_loandisk_borrower_id
  on applications (loandisk_borrower_id)
  where loandisk_borrower_id is not null;
