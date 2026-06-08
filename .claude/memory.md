# Session Memory

Read this file at the start of every session. Append key decisions, discoveries, architecture choices, and anything future sessions should know.

---

## 2026-03-25

- **FinScore production credentials ready.** Env vars on Railway: `FINSCORE_CLIENT_ID` (username), `FINSCORE_CLIENT_SECRET` (password), `FINSCORE_AUTH_URL`, `FINSCORE_SCORE_URL`.
- **Fixed Smart product ID:** Was `G;`, corrected to `Q1;`. Availed products: Globe=GL1, Smart=Q1, DITO=DT1 (TelCo Credit Scoring).
- **Created CLAUDE.md** at project root with full codebase documentation.

---

## 2026-04-28 — Post-launch fix batch (Phase A: Issues 2 & 4)

- **Frontend form_data shape (verified from HAR April 21):** `firstName`, `middleName`, `lastName`, `dateOfBirth` (NOT `dob`), `mobile`, `email`, `civilStatus`, `tin`, `employmentStatus`, `monthlyIncome`, present-address (`presentHouseStreet`/`barangay`/`presentCity`/`presentProvince`/`presentZip`/`presentLengthOfStay`), permanent-address (`permanent*`), business (`businessName`/`businessType`/`businessStreet`/`businessBarangay`/`businessCity`/`businessProvince`/`businessZip`/`dtiNumber`/`dateEstablished`), co-borrower (`coBorrower*`), `paymentTerm` (NOT `loanTerm`), `purpose`, `sales_officer_id`, `consentAgreed`.
- **Field-name drift was root cause of Issues 2/4.** `services/loandisk.js` was reading legacy keys (`dob`, `address`, `city`, `zipcode`) that frontend stopped sending. Fixed mapper accepts both shapes via fallback. Submit route also fixed: `formData.paymentTerm || formData.loanTerm` and `dateOfBirth || dob`.
- **Loandisk PUT semantics:** `"For PUT requests, you must specify all of the data that should exist... If you specify only the fields you want to update, other optional fields will be updated with empty values."` `updateBorrower` does GET → merge non-empty new fields → PUT to preserve photos, access_ids, ops-set custom fields. **Same constraint applies to renewal field-sync (Phase C) — never naive-PUT.**
- **Loandisk loan products discovered (api docs):** Personal=`244322`, SME=`244323`, Group=`245685`, AKAP=`310445`, Sangguniang Barangay=`244329`, *DUMMY=`325946`. Custom fields: `26904`=Barangay, `27065`=Finscore Score, `27066`=Finscore Risk Band, `27067`=Finscore Fraud Flag.
- **Loandisk rate limit:** 1000 req / 5 min, 10000 req / hour. Backfill sleeps 350ms between rows (each row = GET + PUT = 2 req).
- **Middle name strategy:** `MIDDLE_NAME_STRATEGY` constant in `services/loandisk.js`, default `firstname_pack` ("Juan Reyes" Cruz). Other options: `lastname_pack`, `description_only`, `custom_field`. Awaiting ops confirmation.
- **TIN auto-retry on `borrower_unique_number` collision is DISABLED** (`ENABLE_TIN_RETRY=false`) until a real Loandisk conflict response is captured. Naive substring match would false-positive on benign error messages.
- **CLAUDE.md pipeline-stage drift:** doc says `leads → ... → encoder → released` but actual code uses `sales_officer → verifier → ci_officer → approver → loan_processing_officer → declined`. Update CLAUDE.md after batch.

### Open ops questions (blocks Phases B/C/D)
- Issue 6 (loan defaults): `loan_interest`, `loan_interest_method`, `loan_interest_type`, `loan_interest_period`, `loan_payment_scheme_id`, `loan_disbursed_by_id`, `loan_decimal_places`, `loan_application_id` source, `loan_released_date`, middle-name placement.
- Issue 1 (renewal): scope = "all approved apps" — confirmed. Borrower search endpoint TBD this phase.
- Issue 3: 72h auto-expire confirmed. Reject → back to `approver` confirmed.

---

## 2026-04-29 — Issue 6 / Issue 1 / Issue 3 shipped (commit `394f790`)

### BLOCKER (Loandisk loan auto-creation) — RESOLVED
- New: `config/loanProducts.js`, `services/loanCalc.js`, `services/loandisk.js#createLoan` + `buildLoanPayload`. Migration 007 adds approved-rate/fee/loan-id columns.
- Fees field structure decided from `docs/loandisk-api-documentation.pdf` p.32: `loan_fee_id_13777` (Service Processing %) + `loan_fee_id_14282` (Insurance) + `loan_fee_schedule_<id>='charge_fees_on_released_date'`. Send the percentage value as a number (e.g. `5.00`).
- `loan_disbursed_by_id`: out-of-scope per ops, but the API marks it Required. Default `188405` (Cash); env override `LOANDISK_DISBURSED_BY_ID`. **Verify on first staging call.**
- `discount_reason` rejected in validator when `interest_rate < 5`. Persisted both `approved_interest_rate` and `discount_reason`.
- Smoke test verified: 70k → 3500 service + 700 insurance = 4200 fees, 65800 net; 12mo×5%×70k = 42000 (matches BLOCKER.md production sample). Weekly cap at 24 repayments works.

### Issue 1 (renewal) — SHIPPED
- `GET /api/borrowers/search?q=` — Supabase-sourced from `applications` where `loandisk_borrower_id IS NOT NULL`. Min 2 chars, max 10, deduped, public, rate-limited 30/min. Indexed on `lower(full_name)` + `phone` (migration 008).
- Submit accepts top-level `application_category` (`'new'` | `'renewal'`) and `linked_borrower_id`. Renewal without a valid link → 400.
- Pipeline approval: `executeLoandiskApproval` skips `createBorrower` + file upload when `application_category='renewal'` and `linked_borrower_id` is set. Also reuses `loandisk_borrower_id` when an earlier approval attempt left one — idempotent retry.

### Issue 3 (SA confirmation loop) — SHIPPED
- `/approve` body now accepts `adjusted_amount` + `adjusted_term`. Diff check: if either differs from persisted `loan_amount`/`loan_term`, status → `pending_sa_confirmation`, proposed values stored in `approver_proposed_amount`/`approver_proposed_term`, **no Loandisk push**.
- `/confirm-terms` (admin/super_admin): adopts proposed values, runs deferred push via shared helper, advances stage.
- `/reject-terms` (admin/super_admin): requires non-empty `note`, resets `status='pending'` + `stage='approver'`, clears proposed values, stores `sa_rejection_note` + appends `stage_history` entry of `{ type: 'sa_rejection', by, by_name, at, meta:{ note } }`.
- Statuses now in use: `pending`, `pending_sa_confirmation`, `approved`, `declined` (free text — no DB enum).
- Frontend filter for "SA-rejected, awaiting re-review": `status='pending' AND stage='approver' AND sa_rejection_note IS NOT NULL`.

### Rate limiting
- `express-rate-limit` mounted in `index.js`. `/api/application/submit*` capped at 10/min, `/api/borrowers/*` at 30/min. `app.set('trust proxy', 1)` for Railway.

### Pending
- Verify on first staging approval: fee field structure + Cash placeholder for `loan_disbursed_by_id`. Watch `[loandisk:buildLoanPayload]` log lines.
- No unit tests written (no test runner in repo). Pure helpers in `services/loanCalc.js` are testable when one is added.
- No frontend changes — discount-reason input, scheme dropdown, fee preview, renewal picker, SA confirm/reject screens still TODO on the frontend repo.


---

## Session Log — 2026-06-08 — Security-audit remediation (docs/SECURITY-AUDIT.md)
- **Built:** 25/26 open audit findings fixed across all 3 tiers (Tier 1 public-exposure, Tier 2 atomicity, Tier 3 hardening). New migrations `014_security_constraints.sql` (pending-phone unique index, `documents_incomplete`, `loan_push_claimed_at`) and `015_atomic_stage_history.sql` (`apply_stage_transition`, `bump_returned_count` RPCs).
- **Decisions made:** H1 → require staff JWT on `/borrowers/search` (chosen over PII-mask). M6 lost-update fixed via Postgres `jsonb ||` RPCs called from `transitionStage` + `confirm.js` + verifier-return guard. H10 concurrent-approval fixed with a CAS claim on `loan_push_claimed_at` BEFORE Loandisk side effects, released on failure. H11 persists borrower_id/loan_id immediately after each Loandisk call for retry idempotency.
- **Assumptions introduced:** M2 contentType derived from magic bytes via `detectMimeFromMagic` (no new dep; unknown → octet-stream). M10 presigned-URL validation enforces https always, host allowlist only if `LOANDISK_PRESIGN_HOSTS` set. CORS defaults to gr8lendingcorporation.com ± www unless `CORS_ORIGINS` set.
- **Scope candidates deferred:** [M1] CI `form_data` minimization — needs business decision (is `ci_officer` meant to see full PII, or supply field subset). Dead `verifyAdminSecret`/`verifyAdminSecretOrToken` exports in middleware/auth.js left in place (recommend deleting later).
- **CRITICAL deploy gate:** migrations 014 + 015 MUST be applied (Supabase SQL Editor, by hand) BEFORE pushing — code writes `documents_incomplete` and calls the two RPCs, so deploying first breaks all submits + transitions. Also make `problem-reports` bucket private (H12). e2e harness (`tests/e2e-flow.test.js`) updated: added `is()`/`rpc()` to the mock and switched admin calls from `x-admin-secret` (removed in 199fdd6) to Bearer JWT. 103/103 pass.
- **Open items / next session:** apply migrations → push; ops: rotate ADMIN_SECRET, confirm NODE_ENV=production, set CORS_ORIGINS, make problem-reports private; resolve M1; delete dead admin-secret helpers.
