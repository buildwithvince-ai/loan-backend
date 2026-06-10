# Decisions Log — GR8 Lending Backend

Chronological record of major architectural decisions, pivots, and tradeoffs. Each entry captures what changed, why, and what it replaced.

---

## 001 — Loandisk-First to Supabase-First Architecture
**Date:** 2026-03-25  
**Status:** Active

**Before:** Applications submitted directly to Loandisk on intake. No review layer, no staging, no admin control.

**After:** Applications persist to Supabase first. Loandisk borrower creation only fires on admin approval. Three-tier API: public submit, CI agent (limited), admin (full).

**Why:** Business needed a review + scoring pipeline between intake and loan system entry. Direct Loandisk push gave no opportunity for credit investigation or decline.

**Impact:** All downstream features (CI scoring, pipeline, approvals) depend on this architecture.

---

## 002 — FinScore Sandbox to Production
**Date:** 2026-03-26  
**Status:** Active

**Before:** FinScore integration used sandbox endpoints and mock data.

**After:** Switched to production OAuth2 endpoints. Mapped telco detection: Globe=GL1, Smart=Q1, DITO=DT1 based on availed products.

**Why:** Sandbox data was unreliable for scoring. Production credentials were issued by FinScore.

**Gotcha:** Smart product ID was initially set to `G` — fixed to `Q1` to match FinScore's actual availed product list.

---

## 003 — File Upload to Supabase Storage
**Date:** 2026-03-27  
**Status:** Active

**Before:** No file handling. Documents were collected outside the system.

**After:** Files upload to Supabase Storage (`application-files` bucket) on submit, then transfer to Loandisk via presigned S3 URLs on approval.

**Known risk:** Upload errors are silently skipped with `continue`. An application can be created with zero files if all uploads fail. This was discovered after the storage path collision bug (Decision 005).

---

## 004 — Image Compression on Upload
**Date:** 2026-03-29  
**Status:** Active

**Before:** Raw images stored as-is. Large phone photos (5-10MB each) consumed Supabase storage quickly.

**After:** Images compressed with `sharp` on upload — JPEG quality 80, max 1920px, WebP/PNG converted to JPEG. Non-image files pass through unchanged.

**Tradeoffs:** +300-1000ms latency per submission, ~80MB memory spike for 5 large files. Acceptable for low-volume lending app.

---

## 005 — Storage Path Collision Fix
**Date:** 2026-03-30  
**Status:** Active

**Before:** Files stored as `{reference_id}/{filename}`. Multiple form fields with the same filename (e.g. two fields both uploading `photo.jpg`) would overwrite each other.

**After:** Storage path prefixed with fieldname: `{reference_id}/{fieldname}_{filename}`. Applied to both `/submit` and `/submit-group`.

**Why:** Discovered via missing documents in approved applications. Silent upload failure pattern (Decision 003) masked the root cause.

---

## 006 — Static Secrets to JWT Auth + RBAC
**Date:** 2026-03-31  
**Status:** Superseded by Decision 009 (multi-role)

**Before:** Two shared static secrets: `ADMIN_SECRET` and `CI_SECRET` as header values. No per-user identity, no audit trail.

**After:** Supabase Auth JWT tokens with `admin_users` table linked by UUID. Six roles: super_admin, admin, sales_officer, verifier, ci_officer, loan_processing_officer.

**Why:** Pipeline stage enforcement required per-user identity. Static secrets couldn't distinguish who performed an action.

---

## 007 — Pipeline Stage Engine
**Date:** 2026-03-31  
**Status:** Active

**Before:** Flat approve/decline model. No intermediate stages, no history, no stage ownership.

**After:** Six-stage pipeline: sales_officer → verifier → ci_officer → approver → loan_processing_officer (+ declined branch). Enforced transitions with guards, stage_history tracking, backward moves blocked by default.

**Key design rules:**
- `stage` = operational position in pipeline. `status` = final outcome (pending/approved/declined).
- Loandisk push only fires inside the `approver→loan_processing_officer` guard.
- Old admin approve/decline routes became thin wrappers delegating to `transitionStage()`.

---

## 008 — Email Automation + SO Confirmation Flow
**Date:** 2026-04-04  
**Status:** Active

**Before:** No automated notifications. Team relied on manual checking of the dashboard.

**After:** ZeptoMail integration with branded HTML emails. Every pipeline stage transition fires notifications to the relevant role. SO confirmation flow sends confirm/decline email links with 48-hour single-use tokens.

**Architecture choices:**
- Email hooks are fire-and-forget (async IIFE inside `transitionStage`). Failures logged but never break the API response.
- Confirmation tokens stored in `confirmation_tokens` table with expiry and used flag.
- Public `GET /api/confirm/:token` renders branded HTML pages — no auth needed, token is the auth.

**Env vars:** `ZEPTO_API_TOKEN`, `ZEPTO_API_URL`, `ZEPTO_FROM_EMAIL`, `ZEPTO_FROM_NAME`

---

## 009 — Single Role to Multi-Role per User
**Date:** 2026-04-04  
**Status:** Active (supersedes Decision 006 role model)

**Before:** Each user had exactly one `role` (text column). Lean team meant creating duplicate accounts for the same person.

**After:** `role` column replaced with `roles` text[] array. Users can hold multiple roles (e.g. `["sales_officer", "verifier"]`). New `approver` role added alongside admin/super_admin for approval-stage access.

**Migration:** 006_role_to_roles_array.sql — adds `roles text[]`, migrates existing `role` values into array, drops old column, adds GIN index.

**Code changes:**
- `requireRole()` middleware checks array intersection instead of exact match.
- Pipeline guards check `user.roles` array.
- Email `notifyTeamByRole` uses `.contains('roles', [role])` for array queries.
- User CRUD accepts `roles` as array or string (auto-wrapped).

---

## 010 — Backward Pipeline Transitions (Selective)
**Date:** 2026-04-04  
**Status:** Active

**Before:** All backward stage moves were blocked unconditionally.

**After:** Backward moves are still blocked by default, but allowed when an explicit guard exists for that specific pair. First implementation: `verifier→sales_officer` return with required `return_reason` and `returned_count` tracking.

**Why:** Verifiers need to send incomplete applications back to the sales officer for corrections. Blanket backward blocking prevented this legitimate workflow.

---

## 011 — Public Sales Officer Endpoint
**Date:** 2026-04-04  
**Status:** Active

**Before:** No way for the frontend form to know which sales officers exist. SO assignment happened manually after submission.

**After:** `GET /api/public/sales-officers` returns active SOs (id + name) with no auth. Frontend form includes a dropdown for applicants to select their assigned SO. Both `/submit` and `/submit-group` validate and persist `sales_officer_id`.

**Why:** Enables SO assignment at intake rather than post-submission, reducing manual admin work.

---

## 012 — Loandisk Loan Auto-Creation
**Date:** 2026-04-29  
**Status:** Active

**Before:** Approval flow created the Loandisk borrower but did not create the loan record. Ops keyed loan terms manually in Loandisk after approval.

**After:** On approval, `services/pipeline.js` invokes `createLoan` (in `services/loandisk.js`) with the full `add_loan` payload. Pure helpers in `services/loanCalc.js` derive repayments, fees, and total interest. Static config in `config/loanProducts.js` maps loan_type → Loandisk product id and allowed payment schemes.

**Decisions captured from ops (BLOCKER.md):**
- Interest rate: 5% default, monthly, flat_rate, applied across the loan term. Approver may discount down to 3% with a required `discount_reason`.
- Payment schemes: Monthly=3, 15-30 semi-monthly=3413 (NOT biweekly=9), Weekly=4 (AKAP only, capped at 24 repayments).
- Fees: 5% service processing (`loan_fee_id_13777`) + 1% insurance (`loan_fee_id_14282`), both deductible, scheduled `charge_fees_on_released_date`. Field IDs sourced from `docs/loandisk-api-documentation.pdf` p.32.
- `loan_disbursed_by_id`: out-of-scope per ops, but Loandisk marks it Required. Default Cash (188405); env override `LOANDISK_DISBURSED_BY_ID`.
- Decimal places: `round_off_to_two_decimal`. Duration period: `Months`. Range 3-24 months.

**Migration:** 007_loan_creation_fields.sql — `approved_interest_rate`, `discount_reason`, `payment_scheme_id`, `num_of_repayments`, `service_fee_amount`, `insurance_fee_amount`, `total_fees_amount`, `net_disbursement_amount`, `total_interest_amount`, `loandisk_loan_id`, `loan_released_at`.

**To verify on first staging call:** fee field structure (`loan_fee_id_<id>` percentage value) and whether Loandisk accepts the Cash placeholder for `loan_disbursed_by_id`. `[loandisk:buildLoanPayload]` log lines emit the full computed payload + sanity-check on every approval.

---

## 013 — Renewal Flow + Borrower Search
**Date:** 2026-04-29  
**Status:** Active

**Before:** Every approved application created a new Loandisk borrower, even when the applicant was an existing borrower. No way for the frontend to identify prior borrowers at intake.

**After:**
- `GET /api/borrowers/search?q=` — public, rate-limited (30/min), Supabase-sourced from rows where `loandisk_borrower_id IS NOT NULL`. Min 2-char query, max 10 results, deduped by `loandisk_borrower_id`.
- `POST /api/application/submit` accepts `application_category` (`'new'` | `'renewal'`) and `linked_borrower_id` at the top level. Renewal without a valid linked id → 400.
- Approval guard: when `application_category='renewal'` and `linked_borrower_id` is set, `executeLoandiskApproval` skips `createBorrower` + file upload and uses the linked borrower id directly. `loandisk_borrower_id` is also reused on retry (idempotency for ops).

**Migration:** 008_renewal_and_sa_confirmation.sql — adds `application_category`, `linked_borrower_id`, indexes on `lower(full_name)` and `phone` for search performance.

**Why:** Returning borrowers shouldn't be re-created in Loandisk (ops cleanup burden, lost history, duplicate borrower records).

---

## 014 — Approver Modified Terms + SA Confirmation Loop
**Date:** 2026-04-29  
**Status:** Active

**Before:** Approver decisions were a single binary action (approve / decline). Any term adjustment had to happen verbally outside the system.

**After:** `PATCH /api/admin/applications/:id/approve` now accepts `adjusted_amount` and `adjusted_term`. When either differs from the persisted `loan_amount` / `loan_term`, the application flips to `status='pending_sa_confirmation'` and the Loandisk push is deferred until the SA confirms.

- `PATCH /api/admin/applications/:id/confirm-terms` — adopts proposed values into `loan_amount`/`loan_term`, runs the deferred Loandisk push via the shared `executeLoandiskApproval` helper.
- `PATCH /api/admin/applications/:id/reject-terms` — requires `note`, resets `status='pending'` + `stage='approver'`, clears `approver_proposed_*`, stores `sa_rejection_note` and appends a `{ type: 'sa_rejection' }` entry to `stage_history`.

**Migration:** 008 (combined with renewal columns) — `approver_proposed_amount`, `approver_proposed_term`, `approver_proposed_at/by`, `sa_rejection_note`, `sa_rejection_at/by`.

**Status enum (free text, no DB constraint):** `pending`, `pending_sa_confirmation`, `approved`, `declined`.

**Reject target status decision:** `pending` + `stage='approver'`. Reasoning: keeps the application in the approver's queue for re-review without polluting the status enum with another value. Frontend filter for "rejected by SA": `status='pending' AND stage='approver' AND sa_rejection_note IS NOT NULL`.

---

## 015 — Rate Limiting on Public Routes
**Date:** 2026-04-29  
**Status:** Active

**Before:** No throttling on public submit or borrower search. Open to scraping and abuse.

**After:** `express-rate-limit` applied at the router-mount level in `index.js`:
- `/api/application/submit` + `/submit-group`: 10 req / min / IP
- `/api/borrowers/*`: 30 req / min / IP
- `app.set('trust proxy', 1)` so the limiter keys on the real client IP behind Railway's edge.

Tuned for low-volume lending traffic; tight enough to slow scrapers, generous enough not to bite real users.

---

## 016 — Submit Latency Fix (499 client-abort) + Background-Upload PR
**Date:** 2026-06-09
**Status:** A shipped to `main`. C parked in open PR (do not merge yet).

### Trigger
A sales officer reported: PL application submitted fine, then AKAP "failed — something went wrong." Investigated via Railway HTTP logs.

### Root cause (diagnosed, not guessed)
The AKAP submit was **HTTP 499 — client aborted after 181s**, not a backend error. The "successful" PL submit took **107s** — it barely beat the browser timeout. `/submit` ran FinScore (≤35s) + **serial** Supabase Storage uploads (6 KYC images) synchronously before responding; slow Storage pushed total request time past the client timeout.
- "Something went wrong" = the **frontend's** timeout/abort handler, NOT the backend 500 at `application.js` catch.
- The aborted AKAP application was **never saved** (zero AKAP rows in DB that day → SA had to resubmit).
- NOT AKAP-specific, NOT the pre-qual case bug. Pure latency.

Evidence (Railway HTTP, `POST /api/application/submit`): `08:03 200 107159ms` (PL, saved) · `08:15 499 180996ms` (AKAP, lost) · fast `200`s in between were early-exits (declines / "already under review", no row).

### What shipped to `main`
- **A — parallelize uploads** (commit `0189ee6`): both `/submit` and `/submit-group` upload loops → `Promise.all` instead of serial `for`. Wall-clock = slowest single upload, not the sum.
- **Pre-qual case fix** (`0189ee6`): `preQualify()` income/amount lookups now use the normalized lowercase `loanType` (was indexing raw `formData.loanType` while the allowlist used lowercase → a mixed-case type could skip the income/amount gates). Single-member only.
- **Group/SBL case fix** (commit `2de6151`): `/submit-group` member-count + `perMemberLimits` gates now use a normalized `loanTypeKey`; **stored** `loan_type` / group metadata / email payloads keep the raw value, so DB rows + downstream scheme logic are unchanged. e2e harness: 103/103 pass.

### What's parked — PR #1 (`perf/async-submit-uploads`)
**C — respond before upload (background processing) on `/submit` only.** Insert row as `pending` + `documents_incomplete=true`, return `200` immediately, then `processSubmitFiles()` compresses+uploads+patches `file_metadata`+emails verifier off the request path. Cuts client wait to ~FinScore-only.

**Decision: HOLD, don't merge.** A likely already fixes the acute timeout; C adds a fire-and-forget in-memory background task with a durability tradeoff (process restart mid-upload = row flagged incomplete, files gone, manual re-upload). Review notes are a comment on PR #1.

### Resume / merge criteria (THE OPEN ITEM)
Watch `/submit` HTTP logs in prod over the next batch of real submissions:
- **Zero `499`s on A alone + acceptable latency → CLOSE PR #1.** C not needed.
- **Still timing out (499s recur) → MERGE C**, and pair with: (1) durable job queue (pg-boss/Redis) follow-up, (2) a `/submit-group` equivalent (C is `/submit` only).

How to pull the signal: Railway CLI (linked: project `gr8-backend`, service `loan-backend`, env `production`):
`railway logs --http --since <window> --lines 5000 | grep "POST /api/application/submit"` — check the status column for `499`/`5xx`.

### Adjacent gap flagged, NOT fixed (decide later)
`/submit-group` has no loan-type **allowlist** (the L1 guard `/submit` has via `SINGLE_MEMBER_LOAN_TYPES`). An unexpected type sent to the group route skips the member/amount gates rather than being rejected. Separate from the casing fix.
