# Security Audit — Loan Backend (GR8 Lending)

**Date:** 2026-06-08
**Scope:** Full backend (`~5.3k` LOC across routes, services, middleware, config) at commit `199fdd6`.
**Method:** Multi-agent swarm — 8 dimension finders (auth/RBAC, injection, PII/secrets, SSRF/ext-API, file-upload, business-logic, crash/robustness, public-endpoint abuse) → adversarial verify (refute-by-default) per finding. 33 raw findings → de-duplicated and verified against current code.

## Summary

| | Count |
|---|---|
| Confirmed real defects | **26 open** + 4 fixed |
| — Critical | 0 |
| — High | 13 |
| — Medium | 10 |
| — Low | 3 |
| Already fixed (this engagement) | 4 |
| Refuted (not exploitable) | 1 |

> No critical findings survived verification. The highest-impact open item is **#1 (public PII enumeration on `/api/borrowers/search`)**.

---

## 🛠️ Remediation shipped — 2026-06-08 (this session)

All three tiers implemented in code. **25 of 26** open findings fixed; **M1 deferred** (business decision — see below).

| # | Fix | File(s) |
|---|---|---|
| H1 | `/borrowers/search` now requires a staff JWT (`verifyToken + requireRole`) | `routes/borrowers.js`, `index.js` |
| H2 | sharp `limitInputPixels: 24M` + `failOn:'error'`; concurrency bounded by 12-file cap | `services/compress.js` |
| H3 | upload failures aggregated → `documents_incomplete` flag; blocks `verifier→ci_officer` | `routes/application.js`, `services/pipeline.js`, mig 014 |
| H4 | per-product `min_amount`/`max_amount` enforced in `validateLoanInputs` | `config/loanProducts.js`, `services/loanCalc.js` |
| H5 | DOB now required (missing/invalid → prequal fail) on submit + per group member | `routes/application.js` |
| H6 | weekly-scheme (AKAP) duration capped at 6 months in `validateLoanInputs` | `services/loanCalc.js` |
| H7 | partial unique index on pending phone + `23505` → generic ack | mig 014, `routes/application.js` |
| H8 | atomic token consume (CAS `used=false … returning`); confirm gates on it | `services/tokens.js`, `routes/confirm.js` |
| H9 | multer `fileSize 5MB` + `files 12` + clean 400; member cap | `routes/application.js` |
| H10 | approval claim (CAS on `loan_push_claimed_at`) before side effects; released on failure | `services/pipeline.js`, mig 014 |
| H11 | borrower id + loan id persisted immediately after each Loandisk call | `services/pipeline.js` |
| H12 | `problem-reports` private: store path, mint 7-day signed URL for email | `routes/reports.js` |
| M2 | contentType derived from magic bytes, not client mimetype (`detectMimeFromMagic`) | `services/compress.js`, `routes/application.js` |
| M3 | report screenshot filename sanitized (`path.basename` + allowlist) | `routes/reports.js` |
| M4 | `ci_score` bounded to 0–50 (number check) | `routes/admin.js`, `routes/ci.js` |
| M5 | `member.mobile` / leader mobile required before dedupe | `routes/application.js` |
| M6 | atomic `apply_stage_transition` + `bump_returned_count` RPCs | mig 015, `services/pipeline.js`, `routes/confirm.js` |
| M7 | FinScore logs mask mobile (last 4); full response gated behind `FINSCORE_DEBUG=1` | `services/finscore.js`, `routes/application.js` |
| M8 | 5xx handlers return generic `Internal server error` (detail stays in logs) | `routes/admin.js`, `routes/ci.js`, `routes/pipeline.js` |
| M9 | FinScore token POST `timeout: 10000` | `services/finscore.js` |
| M10 | Loandisk per-call timeouts + presigned-URL https/host validation | `services/loandisk.js` |
| L1 | `loanType` allowlist (personal/sme/akap) on `/submit` | `routes/application.js` |
| L2 | CORS explicit origin allowlist (`CORS_ORIGINS` env) | `index.js` |
| L3 | group/SBL member count capped (`MAX_GROUP_MEMBERS=30`) | `routes/application.js` |
| — | Resend email POST `timeout: 10000` | `services/email.js` |

**Deferred — M1 (CI phone-lookup returns full `form_data`):** left as-is to avoid breaking the CI form pre-fill. A credit interviewer arguably needs full applicant data to conduct the interview. **Decision needed:** confirm `ci_officer` is intended to see the full PII blob, or supply the exact field subset the CI form needs so it can be projected down.

**Dead code noted (not removed):** `middleware/auth.js` still exports `verifyAdminSecret` / `verifyAdminSecretOrToken` (the removed `x-admin-secret` minters). No longer mounted anywhere, but they remain a re-wiring footgun — recommend deleting in a follow-up.

### Ops prerequisites before / alongside deploy
1. **Apply migrations by hand** (Supabase SQL Editor, no runner): `014_security_constraints.sql`, `015_atomic_stage_history.sql`. **H7's unique index will fail if duplicate pending rows exist** — dedupe first (snippet in 014). Until 014/015 are applied, the H7 409 path, H10 claim, H3 flag, and M6 RPCs will error against the live DB.
2. **Make the `problem-reports` bucket PRIVATE** in Supabase (H12) — code now signs URLs, but a still-public bucket leaves old objects readable.
3. **Set `CORS_ORIGINS`** on Railway (comma-separated) if the prod origins differ from `gr8lendingcorporation.com` / `www.` (L2).
4. *(optional)* Set `LOANDISK_PRESIGN_HOSTS` (comma-separated host suffixes) to tighten M10 host allowlist; https is always enforced.
5. *(optional)* `FINSCORE_DEBUG=1` only when actively debugging FinScore (re-enables full-response logging).
6. Prior-engagement ops items still stand: confirm `NODE_ENV=production`, rotate `ADMIN_SECRET`, audit `admin_users.roles[]`.

---

## ✅ Fixed in this engagement (commit `199fdd6`)

| Finding | File | Fix |
|---|---|---|
| Admin read routes had no RBAC — any active staff JWT could read all apps + signed KYC URLs by id/phone (IDOR) | `routes/admin.js` | `requireRole(...)` on all read routes |
| `x-admin-secret` minted synthetic `super_admin`, shipped in frontend bundle (`VITE_ADMIN_SECRET`) | `middleware/auth.js`, `routes/admin.js` | Removed bypass; admin router is JWT-only |
| Pipeline `/history` + `/files` had no role gate (IDOR) | `routes/pipeline.js` | `requireRole(...)` on read routes |
| Unauthenticated `/test-*` routes (destructive DB delete, live FinScore/Loandisk/email) reachable in prod | `routes/application.js` | `404` when `NODE_ENV==='production'` |

**Ops follow-through required (see end of doc):** confirm `NODE_ENV=production` on Railway; rotate `ADMIN_SECRET` (was browser-exposed); audit `admin_users.roles[]` for blanks.

---

## ❌ Refuted (verified NOT exploitable)

- **Storage-key path traversal** (`routes/application.js`) — keys are built from unsanitized `fieldname`/`originalname`, but Supabase/S3 treat keys as opaque strings (`../` is literal, not directory traversal), `upsert:false` + millisecond `reference_id` prevent collisions. Sloppy but harmless. *Hardening (sanitize names) still advisable but no vulnerability.*

---

## HIGH (13 open)

### H1 — `/api/borrowers/search` exposes customer PII unauthenticated  🔴 top priority
`routes/borrowers.js:18-48` · mounted public at `index.js:57` (rate-limit only, no auth).
Returns `full_name, phone, loandisk_borrower_id` for any approved borrower on a 2-char query. Anyone on the internet can enumerate customer name + phone. Also `/submit` returns a distinct "already under review" message → applicant enumeration.
**Fix:** require auth on `/borrowers/search` (it backs an internal renewal flow) or mask PII + require longer query; return generic ack on `/submit` duplicate.

### H2 — sharp decompression-bomb DoS
`services/compress.js:28` — `sharp(file.buffer)` with no `limitInputPixels` (default 268MP); `compressFiles` decodes all files concurrently via `Promise.all`. A KB-sized crafted image decodes to 1GB+ RGBA → OOM on Railway. Unauthenticated path (`/submit`).
**Fix:** `sharp(file.buffer, { limitInputPixels: 24_000_000, failOn: 'error' })`; bound concurrency.

### H3 — Failed upload silently dropped → app persisted with missing documents
`routes/application.js:218` (and submit-group ~`:444`) — on upload error: `console.error; continue`. Record saved with `status:success`, missing KYC docs, no flag. Can be approved and pushed to Loandisk without ID/income docs. *(Known: matches `project_silent_failures` note.)*
**Fix:** aggregate failures; fail submission or persist `documents_incomplete` flag that blocks pipeline advance.

### H4 — Approver loan amount/term bypasses product min/max
`services/loanCalc.js:113` — `validateLoanInputs` checks `principal > 0` + global duration `[3,24]` only. No per-product amount band (`PRODUCT_CONFIG` has none). Approver `adjusted_amount` flows to `createLoan` unvalidated → e.g. 999,999 AKAP loan vs 40k cap.
**Fix:** add `min_amount`/`max_amount` to `PRODUCT_CONFIG`; enforce in `validateLoanInputs` + `/confirm-terms`.

### H5 — Age pre-qualification skipped when DOB absent
`routes/application.js:16` (group `:389`) — 21–65 check wrapped in `if (dobValue)`. DOB never required → omit it to bypass age gate entirely. Public endpoint; regulatory/lending compliance risk.
**Fix:** treat missing/invalid DOB as a prequal failure in both `preQualify` and the group loop.

### H6 — Weekly (AKAP) repayment clamp → duration/num_repayments mismatch to Loandisk
`services/loanCalc.js:38` — weekly scheme returns `min(months*4, 24)`. For AKAP duration 7–24mo, `num_of_repayments` clamps to 24 while `loan_duration` sends full months → inconsistent record; Loandisk auto-derives a different count. Can break/misprice the loan. *(Related to `project_akap_scheme_collision` note.)*
**Fix:** cap AKAP weekly duration to 6 months in `validateLoanInputs`, or stop clamping and let Loandisk derive.

### H7 — Duplicate-application guard is non-atomic (race + no DB constraint)
`routes/application.js:150-162` — SELECT-pending-then-INSERT with ~83 lines (incl. FinScore call + uploads) between. No unique constraint on `phone`. Concurrent `/submit` → duplicate apps, **duplicate FinScore charges**, duplicate uploads. Public, 10/min/IP only.
**Fix:** partial unique index `CREATE UNIQUE INDEX ON applications (phone) WHERE status='pending'`; handle conflict as 409. Or Idempotency-Key.

### H8 — Confirmation token consume is non-atomic → replay
`routes/confirm.js:133-149` + `services/tokens.js:96-100` — `validateToken` (reads `used=false`) then `consumeToken` UPDATE has no `used=false` precondition. Concurrent requests both pass → duplicate `so_decision` writes + duplicate approver emails. Unauthenticated, not rate-limited (link prefetchers fire twice).
**Fix:** `UPDATE confirmation_tokens SET used=true WHERE token=$1 AND used=false RETURNING id`; proceed only if a row returned.

### H9 — No file-size/count/body limits on public submit → DoS
`routes/application.js:4` (`memoryStorage()`, no `limits`, `upload.any()`) + `index.js:43`. Unbounded files buffered in RAM; `members[]` on submit-group unbounded → unbounded parallel FinScore calls. `reports.js` already caps at 5MB — this path doesn't.
**Fix:** `limits: { fileSize: 5*1024*1024, files: 12 }`; swap `upload.any()` → `upload.fields([...])`; cap `members.length`; bound scoring concurrency.

### H10 — Concurrent approval → duplicate Loandisk loans (TOCTOU)
`services/pipeline.js:48` — idempotency check reads `loandisk_loan_id` once (line ~34); the later update has no `.is('loandisk_loan_id', null)` precondition. Two concurrent approve/transition calls both see null → two `createBorrower`+`createLoan`. Sequential re-approval IS guarded; concurrent is not.
**Fix:** conditional update `.is('loandisk_loan_id', null)`, proceed only if `rowCount===1`; or DB unique constraint.

### H11 — Borrower id not persisted before file upload → duplicate borrowers on retry
`services/pipeline.js:138` — `createBorrower` id held in a local var; `uploadAllFiles` + `createLoan` run before `loandisk_borrower_id` is written (~`:194`). `uploadAllFiles` throws on first failing file (no per-file catch) → id never saved → reuse guard at `:133` never fires → retry creates a second orphaned borrower.
**Fix:** persist `loandisk_borrower_id` immediately after `createBorrower`, before uploads/createLoan.

### H12 — Problem-report screenshots served via permanent public URL *(first pass)*
`routes/reports.js:53-56` — `getPublicUrl()` returns a non-expiring unsigned URL on screenshots that routinely capture applicant PII (name/phone/score). Only place in repo not using `createSignedUrl`.
**Fix:** make `problem-reports` bucket private; store path only, `createSignedUrl` on demand behind auth.

### H13 — *(consolidated into H9)* multer no-limits / unbounded uploads — same root cause.

---

## MEDIUM (10 open)

### M1 — CI phone-lookup returns full `form_data` to all CI-tier roles
`routes/ci.js:29-39` — widens select to `${CI_FIELDS}, form_data`, returning the entire PII blob (address, TIN, employment, income) to `ci_officer`, against the documented "limited fields" intent.
**Fix:** project only the keys the CI form needs, or confirm ci_officer is intended to see full PII.

### M2 — Client content-type trusted → stored SVG/HTML XSS
`routes/application.js:214` — uploads with `contentType: file.mimetype` (client-declared, no magic-byte check). An SVG declaring `image/jpeg` is stored and later served (admin signed URL / public report URL) → stored XSS when viewed.
**Fix:** validate magic bytes (`file-type`); derive contentType from sharp's detected format; force `Content-Disposition: attachment` for non-images on public buckets.

### M3 — Report screenshot stored under unsanitized client filename
`routes/reports.js:40` — `${req.user.id}/${Date.now()}_${originalname}`, `originalname` unsanitized. Authed + 5MB + mime filter limit blast radius; `../` could still cross user namespace within the bucket.
**Fix:** `path.basename` + sanitize, or derive extension from validated mimetype.

### M4 — CI score accepted without bounds/type validation
`routes/admin.js:215` (+ `routes/ci.js:72`) — `ci_score` → `(ci_score/50)*100` with no check. `ci_score=100` → normalized 200 → final capped 100 → `approved`. `undefined` → `NaN` written to DB. `validateCiRepaymentFields` does not cover `ci_score`. Staff-gated, but a real integrity gap.
**Fix:** `const s = Number(ci_score); if (!Number.isFinite(s) || s<0 || s>50) return 400;` — same in `ci.js`.

### M5 — submit-group stores rows with null phone when member lacks `mobile`
`routes/application.js:312` — `leader = members[0]`; `.eq('phone', leader.mobile)` with `undefined` matches nothing → dedupe bypassed. Per-member format check only runs `if (member.mobile)`, so missing-mobile members pass and persist with null phone. Public endpoint.
**Fix:** require `mobile` per member; reject leader if `!leader.mobile` before dedupe queries.

### M6 — Stage-history concurrent updates clobber each other (lost update)
`services/pipeline.js:424` — read `stage_history`, append in JS, write whole array back (non-atomic). Same for `returned_count`. Concurrent transitions / `confirm.js` rewriting history → last-writer-wins, audit entries lost. Regulated-lending audit reliability.
**Fix:** append atomically server-side (Postgres `jsonb ||` via RPC); increment counters with SQL expression.

### M7 — Full FinScore response (phone + credit score) logged every call *(first pass)*
`services/finscore.js:107,125` — unconditional `console.log` of mobile + full response body. Standing PII/financial sink in Railway logs, no redaction/gate.
**Fix:** remove or gate behind a debug flag; mask mobile (last 4).

### M8 — Raw DB/internal error messages returned to clients *(first pass)*
`routes/admin.js:21,167,185,491` + `routes/ci.js:24,42,130` — `res.status(5xx).json({ error: error.message })` leaks PostgREST/schema text. No global error middleware. Reachable by lower-priv authed roles.
**Fix:** return generic message/code to client; keep `error.message` in `console.error`. Centralize via error helper.

### M9 — FinScore OAuth token fetch has no timeout *(first pass)*
`services/finscore.js:15` — token POST has no `timeout` (default infinite); `getScore` depends on it inside public `/submit`. A hung auth endpoint hangs the request (the 25s timeout on the score call doesn't cover the token call).
**Fix:** add `timeout: 10000`; let auth failure flow into the existing `noScore` fallback.

### M10 — Loandisk axios calls have no timeouts (+ presigned-URL trust) *(first pass)*
`services/loandisk.js` (all calls; acute at `:435` PUT to upstream-supplied `presigned_url`) — no timeouts; a stalled S3/Loandisk endpoint hangs the approval indefinitely; serial loop multiplies. URL used verbatim from upstream.
**Fix:** add per-call `timeout`; validate the presigned URL (https + host allowlist) before PUT; shared axios instance with default timeout.

---

## LOW (3 open)

### L1 — `loanType` not validated on `/submit`
`routes/application.js:34` — unmapped/missing `loanType` → income/amount limits skipped; app accepted + scored. *Downgraded:* approval is blocked later by the `getProductConfig` guard, so no loan is created — data-quality, not security.
**Fix:** allowlist `loanType` (personal|sme|akap) at input.

### L2 — CORS reflects any origin with credentials
`index.js:37-42` — `origin: true` + `credentials: true`. *Downgraded:* sensitive routes are JWT-protected (CORS doesn't bypass auth); public routes expose no sensitive data.
**Fix:** explicit origin allowlist (public form + dashboard).

### L3 — Group/SBL submit fans out one FinScore call per member, no max *(first pass)*
`routes/application.js:400` — only a lower bound on members; unbounded `Promise.all` of billed FinScore calls. Per-IP rate limit blunts but per-request fan-out is unbounded.
**Fix:** cap members per type; bound concurrency.

*(First pass also flagged Resend email POST has no timeout — `services/email.js:123`, low; add `timeout: 10000` or make submit-path notification fire-and-forget.)*

---

## Remediation roadmap

**Tier 1 — do first (public exposure / cheap):**
- H1 `borrowers.js` auth/mask · H2 sharp pixel cap · H9 multer limits · H5 DOB required · M4 ci_score bounds · M5 member.mobile required · L1 loanType allowlist · L2 CORS allowlist

**Tier 2 — DB/atomicity (needs hand-applied Supabase migrations):**
- H7 partial unique index (dup app) · H8 atomic token consume · H10 approval CAS · H11 persist borrower-id early · M6 atomic stage_history

**Tier 3 — correctness / hardening:**
- H3 silent upload drop · H4 product amount bands · H6 AKAP weekly clamp · H12 private report bucket · M1 CI form_data minimization · M2 magic-byte content-type · M3 filename sanitize · M7 redact FinScore logs · M8 generic error responses · M9/M10/L3 external-API timeouts + caps

**Needs a business decision:** is `/borrowers/search` meant to be public (renewal flow)? Who should see full applicant records (true per-applicant IDOR scoping)?

---

## Ops checklist (from fixes already shipped)

1. **Confirm `NODE_ENV=production` on Railway** — if unset, the test-route guard is a no-op and `test-cleanup` (destructive delete) stays open.
2. **Rotate `ADMIN_SECRET`** — it shipped in the frontend bundle; treat as compromised. Admin auth no longer uses it.
3. **Audit `admin_users.roles[]`** — any account with empty/unknown roles now gets 403 on reads.
4. **Smoke test** now uses Bearer JWT — set `SMOKE_ADMIN_EMAIL` / `SMOKE_ADMIN_PASSWORD` in `.env` (account with role in admin/super_admin/ci_officer/approver).
5. **Frontend follow-up:** add a 401 → re-login handler (token TTL ~1h, no refresh); fix stale `.claude/memory.md:33` (still references `x-admin-secret`).
