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

