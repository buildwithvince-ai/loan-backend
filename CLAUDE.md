# Loan Backend — GR8 Lending Corporation

> **Start of every session:** Read `.claude/memory.md` for key decisions and context from prior sessions. Append new decisions, discoveries, and architecture choices as you work.

Loan application backend for GR8 Lending Corporation (gr8lendingcorporation.com). Handles intake, credit scoring, admin approval, and Loandisk sync.

## Stack

- **Runtime:** Node.js, Express 5, CommonJS
- **Database & Storage:** Supabase (Postgres + `application-files` bucket)
- **External APIs:** FinScore (credit scoring), Loandisk (loan management system)
- **Deployment:** Railway (auto-deploys from `main`)
- **Production URL:** `https://loan-backend-production-cd45.up.railway.app`

## What's Built

- Single-member loan applications (Personal, SME, AKAP) via `/submit`
- Multi-member loan applications (Group, SBL) via `/submit-group`
- FinScore integration with telco detection (Globe=GL1, Smart=Q1, DITO=DT1)
- Admin dashboard API: list, review, CI scoring, approve/decline
- CI agent API: limited-access endpoints for credit interviewers
- Approval workflow: Supabase → Loandisk borrower creation + file transfer
- Pre-qualification rules (age, income, loan limits per type)
- Scoring engine: 50% FinScore + 50% CI score → tier assignment

## Project Structure

```
index.js                    — Entry point, Express setup, health check at /
routes/
  application.js            — /api/application/* (submit, submit-group, test routes)
  admin.js                  — /api/admin/* (list, approve, decline, ci-score)
  ci.js                     — /api/ci/* (CI agent: list pending, submit CI score)
services/
  supabase.js               — Supabase client init
  finscore.js               — FinScore OAuth2 token caching, telco detection, scoring
  loandisk.js               — Loandisk borrower creation, S3 presigned URL file uploads
middleware/
  preQualify.js             — Empty (logic inlined in routes)
```

## Key Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/api/application/submit` | None | Single-member loan application |
| POST | `/api/application/submit-group` | None | Group/SBL multi-member application |
| GET | `/api/admin/applications` | `x-admin-secret` | List all applications |
| PATCH | `/api/admin/applications/:id/ci-score` | `x-admin-secret` | Record CI interview score |
| PATCH | `/api/admin/applications/:id/approve` | `x-admin-secret` | Approve → push to Loandisk |
| PATCH | `/api/admin/applications/:id/decline` | `x-admin-secret` | Decline application |
| GET | `/api/ci/applications` | `x-ci-secret` | List pending (limited fields) |
| PATCH | `/api/ci/applications/:id/ci-score` | `x-ci-secret` | Submit CI score (limited response) |

Test routes: `test-loandisk`, `test-upload`, `test-finscore` under `/api/application/`.

## Environment Variables

```
PORT                      # defaults to 3000
SUPABASE_URL
SUPABASE_SERVICE_KEY
LOANDISK_AUTH_CODE        # Basic auth
LOANDISK_PUBLIC_KEY
LOANDISK_BRANCH_ID
FINSCORE_CLIENT_ID        # username
FINSCORE_CLIENT_SECRET    # password
FINSCORE_AUTH_URL          # OAuth2 token endpoint
FINSCORE_SCORE_URL         # Score API endpoint
ADMIN_SECRET              # x-admin-secret header value
CI_SECRET                 # x-ci-secret header value
```

## Scoring Logic

1. **FinScore** (0–999 raw) → normalized: `(raw - 300) / (999 - 300) * 100`
2. **CI Score** (0–50 raw) → normalized: `(raw / 50) * 100`
3. **Final Score** = 50% FinScore normalized + 50% CI normalized
4. **Tiers:** ≥85 = `approved`, ≥70 = `tier_b`, <70 = `declined`

## Loan Types & Pre-Qualification

| Type | Amount Range | Min Income | Other |
|------|-------------|------------|-------|
| Personal | 10k–30k | 15k | — |
| SME | 50k–300k | 30k | — |
| AKAP | 5k–40k | 10k | — |
| Group | 10k–50k | — | Min 5 members |
| SBL | 5k–100k | — | Min 1 member |

Age requirement: 21–65 for all types. Mobile format: `09XXXXXXXXX`.

## Application Workflow

1. Applicant submits → pre-qual checks → FinScore API call → files to Supabase Storage → record saved as `pending`
2. CI agent conducts interview → submits CI score
3. Admin reviews → final score + tier calculated
4. Admin approves → borrower created in Loandisk → files transferred from Supabase to Loandisk via presigned S3 URLs

## Supabase Schema (applications table)

Key columns: `id`, `reference_id` (GR8-{timestamp}), `phone`, `loan_type`, `full_name`, `form_data` (jsonb), `finscore_raw`, `finscore_normalized`, `ci_score`, `ci_normalized`, `final_score`, `tier`, `status`, `loandisk_borrower_id`, `file_metadata` (jsonb), `group_members` (jsonb), `ci_form_data` (jsonb), `submitted_at`, `reviewed_at`

## Conventions

- Semicolons: yes
- Quotes: single quotes
- Variables/functions: camelCase
- DB columns/API payloads: snake_case
- Async: async/await throughout
- Error handling: try-catch with console.error, safe fallbacks on external API failures
- Auth: header-based (`x-admin-secret`, `x-ci-secret`), checked inline per route file
- Logging: console.log/console.error (no logging library)
- No test suite
- Changes go straight to `main` and auto-deploy
