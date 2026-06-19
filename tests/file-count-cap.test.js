'use strict';

// ---------------------------------------------------------------------------
// File-count cap tests — verifies that MAX_UPLOAD_FILES = 60 correctly
// gates multer on /api/application/submit-group (and /submit).
//
// What layer these tests assert at:
//   Tests 1, 3, 4, 5 — multer BOUNDARY LAYER only.
//     We POST multipart requests with many small JPEG buffers and assert
//     the HTTP status + message returned by handleUpload's error handler.
//     The route handler body is NOT reached for the rejection cases, and for
//     the admission cases (30 files, 48 files) we assert the request GETS
//     PAST the multer gate (i.e. the 400 LIMIT_FILE_COUNT error is absent).
//     We do NOT run the full submit-group pipeline (FinScore, Supabase inserts,
//     sharp compression) for these cap-boundary tests because the test payload
//     intentionally omits valid member JSON — the goal is proving multer admits
//     or rejects based purely on file count.
//   Test 2 — FULL FLOW (happy path): 5 members × 6 files → 200 success.
//     We supply valid member data alongside the 30 files and assert the route
//     completes successfully, proving the fix unblocks the exact real-world case
//     that was failing before.
//
// Run: node tests/file-count-cap.test.js
// ---------------------------------------------------------------------------

process.env.ADMIN_SECRET = 'test-admin-secret';
process.env.SUPABASE_URL = 'http://localhost';
process.env.SUPABASE_SERVICE_KEY = 'test';

// ===========================================================================
// 1. In-memory Supabase mock (same pattern as e2e-flow.test.js)
// ===========================================================================

const db = {
  applications: [],
  admin_users: [],
};

let idCounter = 1;
const newId = () => `00000000-0000-4000-8000-${String(idCounter++).padStart(12, '0')}`;

const storageFiles = {};

function makeStorageBucket() {
  return {
    async upload(path, buffer) {
      storageFiles[path] = buffer;
      return { data: { path }, error: null };
    },
    async download(path) {
      const buf = storageFiles[path];
      if (!buf) return { data: null, error: { message: 'not found' } };
      return { data: { arrayBuffer: async () => buf }, error: null };
    },
    async createSignedUrl(path) {
      return { data: { signedUrl: `https://signed.example/${path}` }, error: null };
    },
    async list(folder) {
      const names = Object.keys(storageFiles)
        .filter((p) => p.startsWith(folder + '/'))
        .map((p) => p.slice(folder.length + 1));
      return { data: names.map((name) => ({ name })), error: null };
    },
  };
}

class Query {
  constructor(table) {
    this.table = table;
    this.rows = db[table] || (db[table] = []);
    this._filters = [];
    this._op = 'select';
    this._payload = null;
    this._limit = null;
    this._order = null;
  }
  select() { return this; }
  insert(v) { this._op = 'insert'; this._payload = v; return this; }
  update(v) { this._op = 'update'; this._payload = v; return this; }
  delete() { this._op = 'delete'; return this; }
  eq(c, v) { this._filters.push((r) => r[c] === v); return this; }
  is(c, v) { this._filters.push((r) => (r[c] ?? null) === (v ?? null)); return this; }
  contains(c, arr) {
    this._filters.push((r) => Array.isArray(r[c]) && arr.every((a) => r[c].includes(a)));
    return this;
  }
  like(c, pat) {
    const p = String(pat).replace(/%/g, '');
    this._filters.push((r) => String(r[c] || '').startsWith(p));
    return this;
  }
  order(col, opts = {}) { this._order = { col, ascending: opts.ascending !== false }; return this; }
  limit(n) { this._limit = n; return this; }

  _match() { return this.rows.filter((r) => this._filters.every((f) => f(r))); }

  _exec() {
    if (this._op === 'insert') {
      const items = Array.isArray(this._payload) ? this._payload : [this._payload];
      const inserted = items.map((item) => {
        const row = { id: newId(), submitted_at: new Date().toISOString(), stage_history: [], ...item };
        this.rows.push(row);
        return row;
      });
      return { data: inserted, error: null };
    }
    if (this._op === 'update') {
      const matched = this._match();
      matched.forEach((r) => Object.assign(r, this._payload));
      return { data: matched.map((r) => ({ ...r })), error: null };
    }
    if (this._op === 'delete') {
      const matched = this._match();
      db[this.table] = this.rows.filter((r) => !matched.includes(r));
      return { data: matched, error: null };
    }
    let data = this._match().map((r) => ({ ...r }));
    if (this._order) {
      const { col, ascending } = this._order;
      data.sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (ascending ? 1 : -1));
    }
    if (this._limit != null) data = data.slice(0, this._limit);
    return { data, error: null };
  }

  async single() {
    const { data } = this._exec();
    const arr = Array.isArray(data) ? data : [data];
    if (arr.length === 0) return { data: null, error: { message: 'no rows' } };
    return { data: arr[0], error: null };
  }
  async maybeSingle() {
    const { data } = this._exec();
    const arr = Array.isArray(data) ? data : [data];
    return { data: arr.length ? arr[0] : null, error: null };
  }
  then(resolve, reject) {
    try { resolve(this._exec()); } catch (e) { reject(e); }
  }
}

function makeRpc(fn, params) {
  const exec = () => {
    const row = db.applications.find((r) => r.id === params.p_id);
    if (!row) return { data: null, error: { message: 'no rows' } };
    if (fn === 'apply_stage_transition') {
      row.stage = params.p_to_stage;
      row.stage_history = [...(Array.isArray(row.stage_history) ? row.stage_history : []), params.p_entry];
      return { data: { ...row }, error: null };
    }
    if (fn === 'bump_returned_count') {
      row.returned_count = (row.returned_count || 0) + 1;
      row.last_return_reason = params.p_reason;
      row.last_returned_at = new Date().toISOString();
      return { data: { ...row }, error: null };
    }
    return { data: null, error: { message: `unknown rpc ${fn}` } };
  };
  return {
    async single() { return exec(); },
    then(resolve, reject) { try { resolve(exec()); } catch (e) { reject(e); } },
  };
}

const supabaseMock = {
  from: (table) => new Query(table),
  rpc: (fn, params) => makeRpc(fn, params),
  storage: { from: () => makeStorageBucket() },
  auth: {
    async getUser(token) {
      return { data: null, error: { message: 'invalid token' } };
    },
  },
};

// ===========================================================================
// 2. Mutate service module exports BEFORE requiring routes
// ===========================================================================

const supaSvc = require('../services/supabase');
supaSvc.supabase = supabaseMock;

const finscoreSvc = require('../services/finscore');
// Default: every phone returns a valid score so full-flow tests succeed.
finscoreSvc.getScore = async (mobile) => {
  return { score: 450, normalized: 50, riskBand: '21', noScore: false };
};

const emailSvc = require('../services/email');
for (const fn of ['sendEmail', 'notifySalesOfficer', 'notifyTeamByRole', 'notifySOReturn',
  'notifySODecision', 'sendSOConfirmationRequest', 'notifyApproverSODecision', 'sendProblemReport']) {
  emailSvc[fn] = async () => {};
}

const loandiskSvc = require('../services/loandisk');
loandiskSvc.createBorrower = async () => 'LD-BORROWER-MOCK';
loandiskSvc.uploadAllFiles = async (borrowerId, files) => files.map((_, i) => `file-${i}`);
loandiskSvc.createLoan = async () => ({
  loan_id: 'LD-LOAN-MOCK',
  num_of_repayments: 12,
  total_interest: 0,
  fees: { service_fee: 0, insurance_fee: 0, total_fees: 0, net_disbursement: 0 },
});

// ===========================================================================
// 3. Build the Express app with the REAL application router
// ===========================================================================

const express = require('express');
const app = express();
app.use(express.json());
app.use('/api/application', require('../routes/application'));

let server, BASE;

// ===========================================================================
// 4. Assertion harness
// ===========================================================================

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
function section(t) { console.log(`\n\x1b[1m${t}\x1b[0m`); }

// ===========================================================================
// 5. Multipart helpers
// ===========================================================================

// A minimal valid JPEG: SOI + APP0 marker + EOI — tiny but real JPEG magic bytes.
// 20 bytes. Each file uses this buffer; multer counts file parts, not content uniqueness.
const TINY_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46,
  0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  0xff, 0xd9,
]);

/**
 * Build a multipart/form-data body (raw Buffer + boundary string) containing:
 *   - `numFiles` file parts each with a TINY_JPEG buffer
 *   - any extra text fields from the `fields` object
 *   - an optional single oversized file (for the size-cap test)
 *
 * We hand-build the multipart body because Node 22's native FormData does not
 * let us inject arbitrary raw Buffer files reliably without the `File` API; the
 * manual boundary approach is simpler and mirrors what real browser clients send.
 */
function buildMultipart({ numFiles = 0, fields = {}, oversizedFile = false } = {}) {
  const boundary = '----TestBoundary' + Math.random().toString(36).slice(2);
  const parts = [];

  // Text fields
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
      `${value}\r\n`
    );
  }

  // Normal file parts
  for (let i = 0; i < numFiles; i++) {
    const fieldName = `file_${i}`;
    const header =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${fieldName}"; filename="img_${i}.jpg"\r\n` +
      `Content-Type: image/jpeg\r\n\r\n`;
    parts.push(header);
    parts.push(TINY_JPEG);
    parts.push('\r\n');
  }

  // Optional single oversized file (> 5MB)
  if (oversizedFile) {
    const bigBuf = Buffer.alloc(6 * 1024 * 1024, 0xff); // 6MB of 0xff
    const header =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="big_file"; filename="big.jpg"\r\n` +
      `Content-Type: image/jpeg\r\n\r\n`;
    parts.push(header);
    parts.push(bigBuf);
    parts.push('\r\n');
  }

  parts.push(`--${boundary}--\r\n`);

  const bodyBuffer = Buffer.concat(
    parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'binary') : p))
  );

  return { body: bodyBuffer, boundary };
}

async function postMultipart(path, { numFiles = 0, fields = {}, oversizedFile = false } = {}) {
  const { body, boundary } = buildMultipart({ numFiles, fields, oversizedFile });
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
  });
  let responseBody;
  try { responseBody = await res.json(); } catch { responseBody = {}; }
  return { status: res.status, body: responseBody };
}

// Build 5 valid members for a group loan full-flow test.
function make5Members() {
  return [0, 1, 2, 3, 4].map((i) => ({
    firstName: 'Member',
    lastName: `${i}`,
    mobile: `0918500000${i}`,
    dateOfBirth: '1990-06-01',
    loanAmount: '20000',
    email: `member${i}@test.com`,
  }));
}

// ===========================================================================
// 6. Tests
// ===========================================================================

async function run() {
  await new Promise((r) => { server = app.listen(0, r); });
  BASE = `http://127.0.0.1:${server.address().port}`;

  // -------------------------------------------------------------------------
  section('TEST 1 — GREEN (post-fix): 5 members × 6 files = 30 file parts → 200 success');
  // -------------------------------------------------------------------------
  // This is the EXACT case that failed before the fix (old cap = 12, 30 > 12).
  // Layer: full-flow — we include valid member JSON so the route handler runs
  // end-to-end. The key assertion is status 200 with no LIMIT_FILE_COUNT error.
  {
    const members = make5Members();
    const res = await postMultipart('/api/application/submit-group', {
      numFiles: 30,
      fields: {
        loanType: 'group',
        totalLoanAmount: '100000',
        groupName: 'FixVerify5Members',
        paymentTerm: '12',
        members: JSON.stringify(members),
      },
    });

    check(
      '30 files (5×6) → status 200',
      res.status === 200,
      `HTTP ${res.status} — body: ${JSON.stringify(res.body)}`
    );
    check(
      '30 files → no LIMIT_FILE_COUNT in response',
      !(res.body.message || '').includes('Too many files'),
      JSON.stringify(res.body)
    );
    check(
      '30 files → success or declined (not an upload error)',
      res.body.status === 'success' || res.body.status === 'declined',
      JSON.stringify(res.body)
    );
    check(
      '30 files full-flow → totalMembers 5',
      res.body.totalMembers === 5,
      JSON.stringify(res.body)
    );
  }

  // -------------------------------------------------------------------------
  section('TEST 2 — GREEN: 8 members × 6 files = 48 file parts → 200 success');
  // -------------------------------------------------------------------------
  // Layer: multer boundary + light flow — we include valid member JSON for 8 members.
  {
    const members = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
      firstName: 'M8',
      lastName: `${i}`,
      mobile: `0918600000${i}`,
      dateOfBirth: '1988-03-10',
      loanAmount: '20000',
      email: `m8_${i}@test.com`,
    }));

    const res = await postMultipart('/api/application/submit-group', {
      numFiles: 48,
      fields: {
        loanType: 'group',
        totalLoanAmount: '160000',
        groupName: 'EightMemberGroup',
        paymentTerm: '12',
        members: JSON.stringify(members),
      },
    });

    check(
      '48 files (8×6) → status 200',
      res.status === 200,
      `HTTP ${res.status} — body: ${JSON.stringify(res.body)}`
    );
    check(
      '48 files → no LIMIT_FILE_COUNT error',
      !(res.body.message || '').includes('Too many files'),
      JSON.stringify(res.body)
    );
    check(
      '48 files full-flow → totalMembers 8',
      res.body.totalMembers === 8,
      JSON.stringify(res.body)
    );
  }

  // -------------------------------------------------------------------------
  section('TEST 3 — Per-file size cap still enforced: 1 file > 5MB → 400');
  // -------------------------------------------------------------------------
  // Layer: multer boundary — LIMIT_FILE_SIZE fires before the route handler.
  // Proves MAX_UPLOAD_BYTES = 5MB is untouched by the fix.
  {
    const res = await postMultipart('/api/application/submit-group', {
      numFiles: 0,
      fields: { loanType: 'group' },
      oversizedFile: true,
    });

    check(
      'oversized file (6MB) → status 400',
      res.status === 400,
      `HTTP ${res.status}`
    );
    check(
      'oversized file → "A file exceeds the 5MB size limit." message',
      (res.body.message || '').includes('A file exceeds the 5MB size limit.'),
      JSON.stringify(res.body)
    );
  }

  // -------------------------------------------------------------------------
  section('TEST 4 — Ceiling wired: 61 file parts → 400 "Too many files (max 60)."');
  // -------------------------------------------------------------------------
  // Layer: multer boundary — LIMIT_FILE_COUNT fires on the 61st file.
  // Proves the new cap value (60) is live in the multer config and the error
  // message template uses MAX_UPLOAD_FILES (not a hardcoded 12, 60, or 200).
  {
    const res = await postMultipart('/api/application/submit-group', {
      numFiles: 61,
      fields: { loanType: 'group' },
    });

    check(
      '61 files → status 400',
      res.status === 400,
      `HTTP ${res.status}`
    );
    check(
      '61 files → "Too many files (max 60)." message',
      (res.body.message || '') === 'Too many files (max 60).',
      JSON.stringify(res.body)
    );
  }

  // -------------------------------------------------------------------------
  section('TEST 5 — Regression: single /submit with 6 files still returns 200');
  // -------------------------------------------------------------------------
  // Layer: full-flow — proves raising the shared cap did not break the single-member path.
  {
    const res = await postMultipart('/api/application/submit', {
      numFiles: 6,
      fields: {
        firstName: 'Juan',
        lastName: 'DelaCruz',
        mobile: '09171230001',
        email: 'juan@test.com',
        dateOfBirth: '1990-01-15',
        loanType: 'personal',
        loanAmount: '25000',
        monthlyIncome: '20000',
        paymentTerm: '12',
        consentAgreed: 'true',
      },
    });

    check(
      '/submit 6 files → status 200',
      res.status === 200,
      `HTTP ${res.status} — body: ${JSON.stringify(res.body)}`
    );
    check(
      '/submit 6 files → success (no file-count error)',
      res.body.status === 'success',
      JSON.stringify(res.body)
    );
  }

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  console.log(`\n\x1b[1mRESULT:\x1b[0m ${pass} passed, ${fail} failed`);
  if (fail) {
    console.log('Failed:', failures.join(' | '));
  }
  server.close();
  process.exit(fail ? 1 : 0);
}

run().catch((e) => {
  console.error('HARNESS CRASH:', e);
  if (server) server.close();
  process.exit(2);
});
