# GR8 Lending — Open To-Dos & Unfinished Business

> Consolidated tracker. Source: this session + `.claude/memory.md` history.
> Last updated: 2026-05-29.

---

## 1. Group Loan Submit Bug (ACTIVE — current session)

**Symptom:** Group/SBL applications from website form not reaching dashboard.

**Backend verified WORKING** (tested 2026-05-26): `POST /api/application/submit-group`
returns `200 + referenceId` with valid payload. Server live (HTTP 200). Bug is frontend-side.

### Fixes done (frontend repo)
- [x] Added `consentAgreed: 'true'` to FormData on both forms.
      NOTE: This is for **data integrity only** — NOT the cause. Backend does not
      reject on missing `consentAgreed` (defaults to `false`, my no-consent curl
      test still returned success).
- [x] Replaced silent `catch {}` with `catch (err)` + console logging.
      THIS is the real lead — the empty catch was hiding the actual failure
      (CORS preflight / network / 500).
- [x] Added diagnostics: dump `fd.entries()` before fetch + log `res.status` + body.

### Next (BLOCKED on user)
- [ ] Run live group submit with DevTools open. Grab `[group submit] ...` console lines.
- [ ] Share status + response body. Real failure mode = whatever the silent catch hid.
- [ ] Confirm: single-member `/submit` works but group fails? → consent is NOT the
      differentiator (both routes treat it identically). Look elsewhere (CORS, members
      JSON shape, endpoint path).

---

## 2. Staging Verification (from 2026-04-29 ship — commit 394f790)

First real Loandisk approval must confirm:
- [ ] Fee field structure: `loan_fee_id_13777` (Service Processing %) +
      `loan_fee_id_14282` (Insurance) + `loan_fee_schedule_<id>`.
- [ ] `loan_disbursed_by_id` Cash placeholder `188405` (env: `LOANDISK_DISBURSED_BY_ID`).
      API marks it Required but ops left out-of-scope — verify it accepts on first call.
- [ ] Watch `[loandisk:buildLoanPayload]` log lines on first staging approval.

---

## 3. Frontend TODOs (not started — frontend repo)

From 2026-04-29 ship. Backend ready, no matching UI yet:
- [ ] Discount-reason input (required when approver sets interest rate < 5%).
- [ ] Payment scheme dropdown (Monthly / 15–30 / Weekly).
- [ ] Fee preview (service + insurance breakdown before submit).
- [ ] Renewal borrower picker (calls `GET /api/borrowers/search?q=`).
- [ ] SA confirm/reject screens (for `pending_sa_confirmation` status).
      Filter for re-review queue: `status='pending' AND stage='approver' AND
      sa_rejection_note IS NOT NULL`.

---

## 4. Backend Tech Debt

- [ ] No test runner in repo. Pure helpers in `services/loanCalc.js` are unit-testable
      once one is added (Jest/Vitest).
- [ ] `MIDDLE_NAME_STRATEGY` (`services/loandisk.js`) default `firstname_pack` —
      awaiting ops confirmation on correct placement.
- [ ] TIN auto-retry on `borrower_unique_number` collision DISABLED
      (`ENABLE_TIN_RETRY=false`) until a real Loandisk conflict response is captured.
      Naive substring match would false-positive.
- [ ] File upload errors silently skipped via `continue` (both submit routes) — known
      risk for missing documents going unnoticed. See `project_silent_failures` memory.

---

## 5. Docs Drift

- [x] CLAUDE.md pipeline stages wrong. Doc said
      `leads → verifier → ci_officer → approver → encoder → released`.
      Actual code: `sales_officer → verifier → ci_officer → approver →
      loan_processing_officer` (+ `declined` terminal branch).
      RESOLVED 2026-05-29 — also fixed the `encoder` → `loan_processing_officer`
      role-name drift in the RBAC roles list.

---

## Resolved (kept for context)
- Logout 500 bug — RESOLVED 2026-05-29. `POST /api/auth/logout` passed `req.user.id`
  (a UUID) to `supabase.auth.admin.signOut()`, which expects a JWT → "invalid number
  of segments" → every logout 500'd (seen in May logs). Fix: `verifyToken` now stores
  `req.token`; logout revokes that token (`middleware/auth.js`, `routes/auth.js`).
- BLOCKER.md (Loandisk loan auto-creation field mapping) — RESOLVED 2026-04-29.
  `config/loanProducts.js`, `services/loanCalc.js`, `createLoan` + `buildLoanPayload`,
  migration 007. Smoke test passed (70k → 4200 fees, 42000 interest).
- Issue 1 (renewal flow), Issue 3 (SA confirmation loop) — SHIPPED 2026-04-29.
