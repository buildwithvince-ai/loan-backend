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
