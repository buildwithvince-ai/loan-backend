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

---

## 2026-07-20 — Weekly health check + CORS 500 fix (branch `claude/gifted-mayer-u7pa5x`)

- **Health check (Railway MCP):** deploy `SUCCESS`/stable since 07-08; resources idle (CPU ~0%, mem 0.46/8 GB, disk 0); `npm audit` 0 vulns (axios already on 1.18.1). All green except the CORS issue below.
- **Bug found:** `CORS_ORIGINS` is **still unset** on Railway (confirmed via railway-agent), so the allowlist = only `gr8lendingcorporation.com` ± www. The `cors` origin callback rejected other origins by **throwing** → Express default handler → **HTTP 500**. On 2026-07-19 a real browser (PH IP 136.158.61.210) hit a burst of 500s on `/api/public/sales-officers` + `/api/borrowers/search` — a legit frontend origin missing from the allowlist read as an outage. The canonical dashboard is `gr8lendingcorporation.com/admin` (see `services/email.js:7`), which IS allowlisted, so the blocked origin is some *other* host we couldn't identify from logs.
- **Fix (commit `9c98927`, index.js):** reject disallowed origins with `callback(null, false)` instead of throwing → cors omits `Access-Control-Allow-Origin`, browser blocks, no 500. Added `console.warn('[cors] blocked disallowed origin: <origin>')` so the missing origin is now diagnosable from logs. Verified locally (allowed→200+ACAO; disallowed→200 no ACAO, was 500; preflight allowed→204+ACAO+methods).
- **Still open (needs ops):** (1) merge branch → `main` to auto-deploy the fix; (2) after deploy, read logs for `[cors] blocked disallowed origin:` to capture the real frontend origin, then set `CORS_ORIGINS` on Railway (comma-separated, include apex+www+that origin) to actually restore that user. The code fix stops the 500s but does NOT by itself re-admit the blocked origin.
- **UAT artifact:** Postman collection "GR8 Loan Backend — CORS UAT (index.js:62 fix)" created in the team workspace (asserts the 5 CORS cases; point it at prod after deploy). Live curl against prod isn't possible from the agent env (proxy denies the Railway host by policy); local curl UAT used instead.

---

## 2026-09-21 — Weekly health check (branch `claude/gifted-mayer-4mfr98`)

- **Infra (Railway MCP):** deploy `SUCCESS` and stable since 2026-09-07 (commit `50be3cc`, HEAD of `main`); service `loan-backend` online, 1/1 replica, no crashes. No errors in deploy logs.
- **Reliability:** HTTP error rate **0%** over the last 7 days (858 requests, 0×5xx, 44×4xx = normal client rejections). Worst bucket still 0% 5xx.
- **Resources — all idle, no limits approaching:** CPU ~0% (max 0.06 cores), memory 0.54 GB / 8 GB (~7%), disk ~0. Network negligible.
- **Git/GitHub:** no open PRs, no open issues; branch in sync with `main`. No unmerged critical fixes pending. CORS fix from 2026-07-20 confirmed merged+deployed (PR #3, commit `3a18371`).
- **ISSUE — vulnerable dependencies (`npm audit`: 5 vulns, 3 high).** Directly relevant because `/submit`, `/submit-group`, `/reports/problem` are unauthenticated multipart upload endpoints and every image runs through sharp (`services/compress.js`, incl. HEIC/HEIF):
  - `multer` 2.1.0→2.4.0 (HIGH, direct): DoS via crafted field names, FD leak on aborted uploads, size-limit bypass via async fileFilter race. Fix: `npm audit fix` (stays in 2.x, non-breaking).
  - `sharp` 0.34.5→0.35.4 (HIGH, direct): libvips/libheif CVEs via malicious images. `limitInputPixels`+`failOn:'error'` mitigate DoS but not memory-corruption CVEs. Fix: `npm audit fix --force` (0.34→0.35 minor; smoke-test compression before deploy).
  - `ip-address` <=10.3.0 (HIGH, transitive): SSRF/trust-boundary bypass. Fix: `npm audit fix`.
  - `qs` (moderate DoS) + `dotenv` (minor) cleared by `npm audit fix`.
  - Remediation plan: apply the non-breaking `npm audit fix` set (multer/ip-address/qs) on this branch, then bump sharp separately and verify compress.js locally, before merging (main auto-deploys, no test gate). **Not applied — awaiting go-ahead.**
- **Open ops item (carried from 2026-07-20):** `CORS_ORIGINS` still unset on Railway. Not an outage (code no longer 500s on disallowed origins), but any frontend origin other than gr8lendingcorporation.com ± www is silently blocked. Needs the real origin from `[cors] blocked` logs.

### 2026-09-23 — dependency fix applied (commit `eb79244`, this branch)

- **Applied** on go-ahead: `npm audit fix` (multer 2.1.0→2.4.0, ip-address→10.7.2, qs→6.16.0, dotenv patched) + `npm audit fix --force` for sharp 0.34.5→0.35.4 (libvips 8.18.6). `npm audit` now reports **0 vulnerabilities**. Only `package.json` (`sharp ^0.35.4`) + `package-lock.json` changed; multer moved via lockfile only (`^2.1.0` already admitted 2.4.0).
- **Verified before push:** smoke test of `services/compress.js` under sharp 0.35.4 — PNG→JPEG resize to 2000px (90% reduction), malformed image still hits the `failOn:'error'` fallback and returns the original, PDF passthrough + magic-byte detection unchanged. `multer` 2.4.0 memoryStorage config constructs cleanly.
- **Deploy mechanism confirmed:** no Dockerfile / railway config → Railway Nixpacks runs `npm ci` from the lockfile. `node_modules` is only PARTIALLY tracked in git (Express/multer/axios/qs but NOT sharp/@supabase/express-rate-limit/@img), which proves the committed `node_modules` is vestigial and the lockfile is authoritative for the deploy. Raised a suggested task to gitignore + untrack `node_modules` (drift risk). **The fix reaches prod only when this branch merges to `main`.**
- **UAT artifact (Postman MCP):** collection "GR8 Loan Backend — Dependency Security UAT (multer 2.4 / sharp 0.35)" + environment "GR8 Backend — UAT target" created in the team workspace (`c83730a7…`). Folder 0 asserts the live commit SHA != pre-fix build `50be3cc`; folder 1 = SAFE malformed-input-rejected-cleanly (4xx not 5xx, <5s, no DB write/email); folder 2 = STAGING-ONLY side-effecting (valid submit / corrupt-image sharp fallback). Not executed from here (this MCP can't run requests; agent proxy blocks the Railway host) — run via Runner/Newman after the branch deploys.
