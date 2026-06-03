# Loandisk Confirmation Needed — Loan Setup & Repayment Schedules

**Date:** 2026-06-03
**From:** Engineering (loan backend)
**Purpose:** Before we run a real end-to-end test that creates actual loans in Loandisk, we need to confirm the values and rules our system sends. If any of these are wrong, loans get created with the wrong schedule, fees, or product — silently. Please confirm or correct each item.

Most answers are a simple **yes / no / correct value**. Items you can't answer, flag and we'll find the right person.

---

## 1. Loandisk Product IDs

Our system maps each loan type to a specific Loandisk loan product. Please confirm each ID below points at the correct product in Loandisk:

| Our loan type | Loandisk product ID | Correct? |
|---|---|---|
| Personal (PL) | 244322 | ☐ |
| SME | 244323 | ☐ |
| Group | 244329 | ☐ |
| SBL | 245685 | ☐ |
| AKAP | 310445 | ☐ |

---

## 2. Payment Scheme (Frequency) IDs

Loandisk identifies repayment frequency by a scheme ID. We use:

| Frequency | Scheme ID | Correct? |
|---|---|---|
| Monthly | 3 | ☐ |
| Semi-monthly (twice a month) | 3413 | ☐ |
| Weekly | 4 | ☐ |

**2a. Semi-monthly day-pairs — important.** Borrowers paid twice a month can fall on different day-pairs: **15 & 30**, **5 & 20**, or **10 & 25**. Our system uses the **single** semi-monthly scheme `3413` for all of them and sets the specific days via the first-repayment date.

> **Question:** Does Loandisk accept scheme `3413` + a first-repayment date for **all** day-pairs (5&20, 10&25, not just 15&30)? **Or** does Loandisk require a **different scheme ID for each day-pair**? If different, please provide the scheme ID for each pair.

---

## 3. Fees

We attach two fees to every loan, sent as a **percentage**:

| Fee | Loandisk fee ID | Sent as | Correct? |
|---|---|---|---|
| Service / processing | 13777 | percentage | ☐ |
| Insurance charge | 14282 | percentage | ☐ |

> **Questions:** (a) Are these fee IDs correct? (b) Are they the **same across all 5 products**, or does any product use different fee IDs? (c) Does Loandisk expect these as a **percentage** (not a flat peso amount)?

---

## 4. Disbursement

Loandisk requires a "disbursed by" value on every loan even though actual disbursement is handled outside the system. We currently send **Cash (ID 188405)** as a placeholder.

> **Question:** Is sending **Cash / 188405** acceptable as a default, or should we send a specific disbursement method? (Options Loandisk lists: 188405=Cash, 188406=Cheque, 188407=Wire Transfer, 188408=Online Transfer.)

---

## 5. Interest Method

We send every loan as **flat-rate** interest, percentage-based, period = Month.

> **Question:** Is **every** product above configured in Loandisk as **flat-rate** interest? If any product uses declining/reducing-balance, tell us which — our setting would mismatch it.

---

## 6. Number of Repayments

We calculate and send the repayment count ourselves: a 12-month **monthly** loan = 12 payments; a 12-month **semi-monthly** loan = **24** payments; weekly is capped at 24.

> **Question:** Does Loandisk expect us to **send** the repayment count, or does it **calculate it automatically** from the term + frequency? (If it auto-calculates and we also send it, we may get a double-length schedule.)

---

## 7. First-Payment Rules Per Product — please confirm each row

This is the core of the schedule. Each product has its own first-payment rule. Confirm or correct:

| Product | Frequency | First payment due | Driven by |
|---|---|---|---|
| **AKAP** | Weekly | Release date **+ 7 days**, then weekly | Fixed (no salary date) |
| **SME** | Monthly | Release date **+ 1 month, same day** (e.g. Jun 10 → Jul 10) | Fixed (no salary date) |
| **SBL** | Monthly | Release **+ 15 days**, then the **honorarium date** | Honorarium date |
| **Personal (PL)** | Semi-monthly | Release **+ 15 days**, then the next **salary date** | Salary date(s) |
| **Group** | Semi-monthly | Release **+ 15 days**, then the next **salary date** | Salary date(s) |

> **Questions:**
> - **AKAP:** Is first payment exactly **release + 7 days**? And do we collect **no salary dates** for AKAP (it's purely weekly)? ☐
> - **SME:** Is first payment **release + 1 month on the same day-of-month**, with **no salary date** involved? ☐
> - **SBL:** Is the honorarium a **fixed monthly day** (e.g. always the 15th)? Or can it be irregular (quarterly, variable)? ☐
> - **"Follow the date":** When we say first payment "follows" the salary/honorarium date, we mean the **first such date that is at least 15 days after release**. Is +15 days the correct minimum gap for **all** of PL/Group/SBL? ☐

---

## 8. Edge Cases

> **8a. End of month:** If a payment day is the 30th or 31st but the month is shorter (e.g. February), should we use the **last day of that month** (Feb 28/29)? ☐
>
> **8b. Weekends / holidays:** If a calculated payment date lands on a weekend or holiday, does Loandisk (or your policy) **shift** it to the next business day, or leave it as-is? ☐

---

## 9. Test Environment (so we can run the test safely)

> **9a.** Is there a **Loandisk sandbox / test branch** we should point at? Or does the API write to the **live** loan book? (Our `BRANCH_ID` — is it a test branch?)
>
> **9b.** If live-only: once we create test loans, can they be **deleted**, or only **voided**? Who can clean them up?

---

## Quick-answer summary (if short on time, these 6 matter most)

1. Product IDs in §1 — all correct? (yes / corrections)
2. Scheme `3413` works for all semi-monthly day-pairs? (yes / need separate IDs)
3. Fee IDs 13777 + 14282 correct and percentage-based? (yes / no)
4. Cash/188405 OK for disbursed-by? (yes / use X)
5. AKAP = release+7 weekly, no salary dates? SME = release+1mo same day, no salary dates? (yes / no)
6. Is `BRANCH_ID` a test branch, and can test loans be cleaned up? (yes / details)
