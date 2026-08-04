# Loan Backend — GR8 Lending Corporation

> **Start of every session:** Read `.claude/memory.md` for key decisions and context from prior sessions. Append new decisions, discoveries, and architecture choices as you work.

Loan application backend for GR8 Lending Corporation (gr8lendingcorporation.com). Handles intake, credit scoring, admin approval, and Loandisk sync.

## Stack

- **Runtime:** Node.js, Express 5, CommonJS
- **Database & Storage:** Supabase (Postgres + Auth + `application-files` bucket)
- **External APIs:** FinScore (credit scoring), Loandisk (loan management system), ZeptoMail (transactional email)
- **Deployment:** Railway (auto-deploys from `main`)
- **Production URL:** `https://loan-backend-production-cd45.up.railway.app`

## What's Built

- Single-member loan applications (Personal, SME, AKAP) via `/submit`
- Multi-member loan applications (Group, SBL) via `/submit-group` with per-member FinScore
- FinScore integration with telco detection (Globe=GL1, Smart=Q1, DITO=DT1)
- JWT auth via Supabase Auth + RBAC with `admin_users` table (roles: super_admin, admin, ci_officer, verifier, approver, sales_officer, loan_processing_officer)
- Pipeline stage engine: 6 stages with email automation on transitions
- Admin dashboard API: list, review, CI scoring, approve/decline, user management
- CI agent API: limited-access endpoints for credit interviewers
- Approval workflow: Supabase → Loandisk borrower creation + file transfer
- Pre-qualification rules (age, income, loan limits per type)
- Scoring engine: 50% FinScore + 50% CI score → tier assignment (+ reapplication bonus)
- ZeptoMail email notifications on submission and stage transitions
- SO confirmation flow via tokenized email links
- Report a Problem endpoint with screenshot upload
- Image compression on upload via sharp

## Project Structure

```
index.js                    — Entry point, Express setup, health check at /
routes/
  application.js            — /api/application/* (submit, submit-group, test routes)
  admin.js                  — /api/admin/* (list, approve, decline, ci-score, user mgmt)
  ci.js                     — /api/ci/* (CI agent: list pending, submit CI score)
  auth.js                   — /api/auth/* (login, logout, me, change-password)
  users.js                  — /api/users/* (CRUD for admin_users)
  pipeline.js               — /api/pipeline/* (stage transitions, history, files)
  confirm.js                — /api/confirm/* (SO confirmation via token)
  public.js                 — /api/public/* (sales officers list)
  reports.js                — /api/reports/* (report a problem)
services/
  supabase.js               — Supabase client init
  finscore.js               — FinScore OAuth2 token caching, telco detection, scoring
  loandisk.js               — Loandisk borrower creation, S3 presigned URL file uploads
  email.js                  — ZeptoMail transactional emails (submission, stage transitions, SO confirmation)
  pipeline.js               — Pipeline stage transition logic and Loandisk push on approval
  compress.js               — Sharp-based image compression for uploads
  tokens.js                 — Token generation/validation for SO confirmation links
  renewal.js                — Server-derived renewal eligibility + FinScore attribution (pure)
middleware/
  auth.js                   — JWT verification via Supabase Auth + requireRole RBAC
  preQualify.js             — Empty (logic inlined in routes)
```

## Key Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/api/application/submit` | None | Single-member loan application |
| POST | `/api/application/submit-group` | None | Group/SBL multi-member application |
| POST | `/api/auth/login` | None | Login → JWT |
| POST | `/api/auth/logout` | Bearer JWT | Logout |
| GET | `/api/auth/me` | Bearer JWT | Current user info |
| PATCH | `/api/auth/change-password` | Bearer JWT | Change password |
| GET | `/api/admin/applications` | Bearer JWT | List all applications |
| GET | `/api/admin/applications/:id` | Bearer JWT | Single application detail |
| GET | `/api/admin/applications/:id/files` | Bearer JWT | Signed file URLs |
| GET | `/api/admin/applications/phone/:phone` | Bearer JWT | Lookup by phone |
| GET | `/api/admin/applications/borrower/:borrowerId` | Bearer JWT | All applications for one client (Loandisk borrower id) |
| PATCH | `/api/admin/applications/:id/ci-score` | JWT + role(admin, super_admin, ci_officer) | Record CI interview score |
| PATCH | `/api/admin/applications/:id/approve` | JWT + role(admin, super_admin) | Approve → push to Loandisk |
| PATCH | `/api/admin/applications/:id/decline` | JWT + role(admin, super_admin) | Decline application |
| GET | `/api/admin/export/consent` | JWT + role(admin, super_admin) | Export consent data |
| GET | `/api/ci/applications` | JWT + role(ci_officer, admin, super_admin, approver) | List pending (limited fields) |
| GET | `/api/ci/applications/phone/:phone` | JWT + role(ci_officer, admin, super_admin, approver) | CI lookup by phone |
| GET | `/api/ci/applications/borrower/:borrowerId` | JWT + role(ci_officer, admin, super_admin, approver) | Client history for CI (CI_FIELDS projection) |
| PATCH | `/api/ci/applications/:id/ci-score` | JWT + role(ci_officer, admin, super_admin, approver) | Submit CI score (limited response) |
| GET/PATCH | `/api/users/*` | Bearer JWT | Admin user CRUD |
| PATCH | `/api/pipeline/:id/transition` | Bearer JWT | Advance pipeline stage |
| GET | `/api/pipeline/:id/history` | Bearer JWT | Stage transition history |
| GET | `/api/pipeline/:id/files` | Bearer JWT | Pipeline file access |
| GET | `/api/confirm/:token` | None (token in URL) | SO confirmation link handler |
| GET | `/api/public/sales-officers` | None | List sales officers |
| POST | `/api/reports/problem` | None | Report a problem with screenshot |

Test routes: `test-loandisk`, `test-upload`, `test-finscore`, `test-email`, `test-cleanup` under `/api/application/`.

## Environment Variables

```
PORT                      # defaults to 3000
SUPABASE_URL
SUPABASE_SERVICE_KEY
LOANDISK_AUTH_CODE        # Basic auth
LOANDISK_PUBLIC_KEY
LOANDISK_BRANCH_ID        # live branch — used when NODE_ENV=production
LOANDISK_TEST_BRANCH_ID   # test branch — used when NODE_ENV != production (add to Railway)
NODE_ENV                  # 'production' selects the live Loandisk branch; else the test branch
FINSCORE_CLIENT_ID        # username
FINSCORE_CLIENT_SECRET    # password
FINSCORE_AUTH_URL          # OAuth2 token endpoint
FINSCORE_SCORE_URL         # Score API endpoint
ADMIN_SECRET              # x-admin-secret header value (matches frontend VITE_ADMIN_SECRET)
ZEPTO_API_URL             # ZeptoMail endpoint (defaults to v1.1)
ZEPTO_API_TOKEN           # Zoho-enczapikey token
ZEPTO_FROM_EMAIL          # Sender email address
ZEPTO_FROM_NAME           # Sender display name (defaults to "GR8 Lending")
BASE_URL                  # Backend URL for confirmation links
OWNER_EMAIL               # Receives problem reports
```

## Scoring Logic

1. **FinScore** (prepaid 300–600 raw) → normalized: `(raw - 300) / 300 * 100`
2. **CI Score** (0–50 raw) → normalized: `(raw / 50) * 100`
3. **Final Score** = `(finNorm * 0.50 + ciNorm * 0.50)` rounded to 1 decimal + reapplication bonus (10 if applicable), capped at 100. Computed by `computeCompositeScore()` in `services/loanCalc.js` — shared by the admin and CI routes. **Renewals do not take the bonus:** they already inherit the prior FinScore, so attribution replaces the bonus.
4. **Tiers:** ≥85 = `approved`, ≥70 = `tier_b`, <70 = `declined`

## Loan Types & Pre-Qualification

| Type | Amount Range | Min Income | Other |
|------|-------------|------------|-------|
| Personal | 10k–200k | 15k | — |
| SME | 50k–300k | 30k | — |
| AKAP | 5k–40k | 10k | — |
| Group | 10k–50k | — | Min 5 members |
| SBL | 5k–100k | — | Min 1 member |

Age requirement: 21–65 for all types. Mobile format: `09XXXXXXXXX`.

## Application Workflow

1. Applicant submits → pre-qual checks → **renewal resolution (server-derived, `services/renewal.js`)** → FinScore API call *(skipped on the renewal fast-path)* → image compression → files to Supabase Storage → record saved as `pending` → email notifications sent

**Renewal resolution.** `application_category` / `linked_borrower_id` arrive from the frontend but are a hint only — the phone is matched against the applicant's own prior applications and the server decides. Two independent outcomes:
   - *Borrower reuse* (`application_category='renewal'`): any prior `status='approved'` row with a `loandisk_borrower_id`. No time limit. Lets approval attach to the existing Loandisk borrower.
   - *FinScore fast-path* (`finscore_attributed=true`): borrower reuse **plus** the source row's `submitted_at` within 90 days **and** a usable prior FinScore. Skips the FinScore call and copies `finscore_raw` / `finscore_normalized`; `attributed_final_score` records the prior composite for audit.

   Refused fast-path reasons (logged, borrower reuse still applies): `score_outside_recency_window`, `prior_finscore_unusable` (manual-override source), `decline_postdates_approval`, `prior_submitted_at_unreadable`. A prior decline still raises `prior_decline_flag` for CI, which now sees it via `CI_FIELDS`.
2. Pipeline stages: `sales_officer` → `verifier` → `ci_officer` → `approver` → `loan_processing_officer` (with email automation on each transition). `declined` is a terminal branch from `approver`. Backward returns: only `verifier` → `sales_officer` is permitted.
3. CI agent conducts interview → submits CI score → auto-advances to approver stage
4. Admin reviews → final score + tier calculated (with reapplication bonus if applicable)
5. Admin approves → borrower created in Loandisk (renewals reuse the linked borrower instead) → files transferred from Supabase to Loandisk via presigned S3 URLs on **every** approval, renewals included (decision 019)
6. SO confirmation via tokenized email link at any stage

## Supabase Schema (applications table)

**applications:** `id`, `reference_id` (GR8-{timestamp}), `phone`, `loan_type`, `full_name`, `form_data` (jsonb), `finscore_raw`, `finscore_normalized`, `ci_score`, `ci_normalized`, `final_score`, `tier`, `status`, `stage`, `loandisk_borrower_id`, `file_metadata` (jsonb), `group_members` (jsonb), `ci_form_data` (jsonb), `ci_recommendation`, `ci_remarks`, `ci_recommended_amount`, `interviewer`, `so_confirmation_sent_at`, `submitted_at`, `reviewed_at`, `application_category`, `linked_borrower_id`, `renewal_source_application_id`, `finscore_attributed`, `attributed_final_score`, `renewal_source_submitted_at`, `renewal_source_reference_id`, `prior_decline_flag`, `prior_decline_reference`

> **Attributed rows carry a copied score.** On `finscore_attributed=true`, `finscore_raw`/`finscore_normalized` are copied from the source application and are byte-identical to a freshly measured score — the copy is load-bearing, since `computeCompositeScore` reads `finscore_normalized`. `renewal_source_submitted_at` + `renewal_source_reference_id` exist so the UI can render the age **on the number itself** (`555 · carried over, measured 12 Jun 2026`) rather than in a separate notice that can be collapsed, printed, or screenshotted away. Both are null on a renewal that re-ran FinScore.

> There is **no** `clients`/`borrowers` table. Client identity is `loandisk_borrower_id` (external Loandisk id, populated on first approval). `linked_borrower_id` points at it from renewals.

**admin_users:** `id` (FK to Supabase Auth), `email`, `full_name`, `roles` (text[]), `is_active`

## Conventions

- Semicolons: yes
- Quotes: single quotes
- Variables/functions: camelCase
- DB columns/API payloads: snake_case
- Async: async/await throughout
- Error handling: try-catch with console.error, safe fallbacks on external API failures
- Auth: JWT via Supabase Auth for admin + CI routes (CI adds `requireRole`), public routes unauthenticated
- RBAC: `requireRole()` middleware checks `admin_users.roles[]` array
- Logging: console.log/console.error (no logging library)
- No test suite
- Changes go straight to `main` and auto-deploy
