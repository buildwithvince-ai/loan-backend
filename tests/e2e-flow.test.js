'use strict';

// ---------------------------------------------------------------------------
// End-to-end application flow test — submit through Loan Processing Officer.
//
// CUT BEFORE LOANDISK: services/loandisk.js is replaced with in-memory spies.
// The approve action runs fully and reaches `loan_processing_officer`, but the
// real Loandisk borrower/loan creation never fires — instead we assert the
// payload the code WOULD have sent.
//
// Boundaries mocked: Supabase (in-memory store), FinScore (scriptable),
// email (no-op spies), Loandisk (recording spies). The real route handlers,
// RBAC middleware, pre-qualification, scoring, and pipeline state machine run
// unchanged over real HTTP.
//
// Run: node tests/e2e-flow.test.js
// ---------------------------------------------------------------------------

process.env.ADMIN_SECRET = 'test-admin-secret';
process.env.SUPABASE_URL = 'http://localhost'; // overwritten below, never used
process.env.SUPABASE_SERVICE_KEY = 'test';

// ===========================================================================
// 1. In-memory Supabase mock
// ===========================================================================

const db = {
  applications: [],
  admin_users: [],
};

let idCounter = 1;
const newId = () => `00000000-0000-4000-8000-${String(idCounter++).padStart(12, '0')}`;

const storageFiles = {}; // path -> buffer

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
    // select
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

const tokenMap = {}; // token -> auth user id

const supabaseMock = {
  from: (table) => new Query(table),
  storage: { from: () => makeStorageBucket() },
  auth: {
    async getUser(token) {
      const uid = tokenMap[token];
      if (!uid) return { data: null, error: { message: 'invalid token' } };
      return { data: { user: { id: uid } }, error: null };
    },
  },
};

// ===========================================================================
// 2. Mutate service module exports BEFORE requiring routes / pipeline
// ===========================================================================

const supaSvc = require('../services/supabase');
supaSvc.supabase = supabaseMock;

const finscoreSvc = require('../services/finscore');
const FINSCORE = {}; // phone -> scripted result
finscoreSvc.getScore = async (mobile) => {
  if (FINSCORE[mobile]) return FINSCORE[mobile];
  return { score: 450, normalized: 50, riskBand: '21', noScore: false }; // default success
};

const emailSvc = require('../services/email');
const emailCalls = [];
for (const fn of ['sendEmail', 'notifySalesOfficer', 'notifyTeamByRole', 'notifySOReturn',
  'notifySODecision', 'sendSOConfirmationRequest', 'notifyApproverSODecision', 'sendProblemReport']) {
  emailSvc[fn] = async (...args) => { emailCalls.push({ fn, args }); };
}

const loandiskSvc = require('../services/loandisk');
const loandiskCalls = { createBorrower: [], createLoan: [], uploadAllFiles: [] };
loandiskSvc.createBorrower = async (formData, finScore) => {
  loandiskCalls.createBorrower.push({ formData, finScore });
  return 'LD-BORROWER-999';
};
loandiskSvc.uploadAllFiles = async (borrowerId, files) => {
  loandiskCalls.uploadAllFiles.push({ borrowerId, count: files.length });
  return files.map((_, i) => `file-${i}`);
};
loandiskSvc.createLoan = async (input) => {
  loandiskCalls.createLoan.push(input);
  const principal = Number(input.principal);
  const service = principal * 0.05;
  const insurance = principal * 0.01;
  return {
    loan_id: 'LD-LOAN-555',
    num_of_repayments: input.duration_months,
    total_interest: principal * (input.interest_rate / 100) * input.duration_months,
    fees: {
      service_fee: service,
      insurance_fee: insurance,
      total_fees: service + insurance,
      net_disbursement: principal - service - insurance,
    },
  };
};

// Pipeline service captures loandisk + email at load — require AFTER mutation.
const pipelineSvc = require('../services/pipeline');

// ===========================================================================
// 3. Build the Express app with the REAL routers (no rate limiter)
// ===========================================================================

const express = require('express');
const app = express();
app.use(express.json());
app.use('/api/application', require('../routes/application'));
app.use('/api/admin', require('../routes/admin'));
app.use('/api/ci', require('../routes/ci'));
app.use('/api/pipeline', require('../routes/pipeline'));

let server, BASE;

// ===========================================================================
// 4. Seed admin_users (one per role) + auth tokens
// ===========================================================================

const ROLES = ['super_admin', 'admin', 'verifier', 'ci_officer', 'approver', 'sales_officer', 'loan_processing_officer'];
function seedUsers() {
  db.admin_users = [];
  for (const role of ROLES) {
    const id = newId();
    db.admin_users.push({ id, email: `${role}@gr8.test`, full_name: `${role} user`, roles: [role], is_active: true });
    tokenMap[`token:${role}`] = id;
  }
}
const userId = (role) => db.admin_users.find((u) => u.roles.includes(role)).id;
const authH = (role) => ({ Authorization: `Bearer token:${role}` });
const adminSecretH = { 'x-admin-secret': 'test-admin-secret' };

// Repayment scheduling fields now required at the CI stage (migration 012).
// Spread into every ci-score body so the validators pass.
const REPAY = { payment_frequency: 'two_times', salary_payout_dates: [15, 30], repayment_cycle: '15-30' };
// loan_release_date required at approval; enforced at the Loandisk push chokepoint.
const RELEASE_DATE = '2026-06-10';

// ===========================================================================
// 5. HTTP helpers
// ===========================================================================

async function postForm(path, fields) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  const res = await fetch(BASE + path, { method: 'POST', body: fd });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function jsonReq(method, path, body, headers = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

// ===========================================================================
// 6. Tiny assertion harness
// ===========================================================================

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(t) { console.log(`\n\x1b[1m${t}\x1b[0m`); }

// A baseline valid single-member personal application form
function validForm(over = {}) {
  return {
    firstName: 'Juan', lastName: 'DelaCruz', mobile: '09171234567', email: 'juan@test.com',
    dateOfBirth: '1990-01-15', loanType: 'personal', loanAmount: '25000', monthlyIncome: '20000',
    paymentTerm: '12', consentAgreed: 'true', ...over,
  };
}

// ===========================================================================
// 7. The test run
// ===========================================================================

async function run() {
  await new Promise((r) => { server = app.listen(0, r); });
  BASE = `http://127.0.0.1:${server.address().port}`;
  seedUsers();

  // -----------------------------------------------------------------------
  section('SUBMIT — pre-qualification declines');
  // -----------------------------------------------------------------------
  {
    const young = await postForm('/api/application/submit', validForm({ dateOfBirth: '2010-01-01', mobile: '09170000001' }));
    check('age < 21 → declined', young.body.status === 'declined' &&
      young.body.reasons.some((r) => r.includes('21 and 65')), JSON.stringify(young.body));

    const old = await postForm('/api/application/submit', validForm({ dateOfBirth: '1950-01-01', mobile: '09170000002' }));
    check('age > 65 → declined', old.body.status === 'declined' &&
      old.body.reasons.some((r) => r.includes('21 and 65')), JSON.stringify(old.body));

    const lowInc = await postForm('/api/application/submit', validForm({ monthlyIncome: '5000', mobile: '09170000003' }));
    check('income < min → declined', lowInc.body.status === 'declined' &&
      lowInc.body.reasons.some((r) => r.includes('income')), JSON.stringify(lowInc.body));

    const badAmt = await postForm('/api/application/submit', validForm({ loanAmount: '999999', mobile: '09170000004' }));
    check('amount out of range → declined', badAmt.body.status === 'declined' &&
      badAmt.body.reasons.some((r) => r.includes('Loan amount')), JSON.stringify(badAmt.body));

    const badMobile = await postForm('/api/application/submit', validForm({ mobile: '12345' }));
    check('bad mobile format → declined', badMobile.body.status === 'declined' &&
      badMobile.body.reasons.some((r) => r.includes('mobile')), JSON.stringify(badMobile.body));
  }

  // -----------------------------------------------------------------------
  section('SUBMIT — FinScore branches');
  // -----------------------------------------------------------------------
  {
    FINSCORE['09171111111'] = { phoneNotFound: true, score: 0, normalized: 0 };
    const pnf = await postForm('/api/application/submit', validForm({ mobile: '09171111111' }));
    check('phone_not_found → 422', pnf.status === 422 && pnf.body.status === 'phone_not_found', JSON.stringify(pnf.body));

    FINSCORE['09172222222'] = { noScore: true, score: 0, normalized: 0 };
    const noScore = await postForm('/api/application/submit', validForm({ mobile: '09172222222' }));
    check('noScore → proceeds, saved as pending (raw 0)', noScore.body.status === 'success', JSON.stringify(noScore.body));
    const noScoreRow = db.applications.find((a) => a.phone === '09172222222');
    check('noScore row persisted with finscore_raw 0', noScoreRow && noScoreRow.finscore_raw === 0, JSON.stringify(noScoreRow));
  }

  // -----------------------------------------------------------------------
  section('SUBMIT — success, duplicate, prior-decline flag');
  // -----------------------------------------------------------------------
  let mainAppId;
  {
    FINSCORE['09173333333'] = { score: 540, normalized: 80, riskBand: '21', noScore: false };
    const ok = await postForm('/api/application/submit', validForm({ mobile: '09173333333' }));
    check('valid new application → success + referenceId', ok.body.status === 'success' && /^GR8-/.test(ok.body.referenceId), JSON.stringify(ok.body));
    const row = db.applications.find((a) => a.phone === '09173333333');
    mainAppId = row.id;
    check('persisted as pending @ verifier stage', row.status === 'pending' && row.stage === 'verifier', JSON.stringify({ s: row.status, st: row.stage }));
    check('finscore_normalized stored (80)', row.finscore_normalized === 80, String(row.finscore_normalized));

    const dup = await postForm('/api/application/submit', validForm({ mobile: '09173333333' }));
    check('duplicate pending phone → blocked', dup.body.status === 'error' && /already under review/.test(dup.body.message), JSON.stringify(dup.body));

    // Seed a declined application for a fresh phone, then re-submit → prior_decline_flag
    db.applications.push({
      id: newId(), reference_id: 'GR8-OLDDECLINED', phone: '09174444444', status: 'declined',
      submitted_at: new Date(Date.now() - 100000).toISOString(),
    });
    FINSCORE['09174444444'] = { score: 540, normalized: 80, noScore: false };
    const reapply = await postForm('/api/application/submit', validForm({ mobile: '09174444444' }));
    check('re-apply after decline → success', reapply.body.status === 'success', JSON.stringify(reapply.body));
    const reRow = db.applications.find((a) => a.phone === '09174444444' && a.status === 'pending');
    check('prior_decline_flag set + reference captured', reRow.prior_decline_flag === true && reRow.prior_decline_reference === 'GR8-OLDDECLINED', JSON.stringify({ f: reRow.prior_decline_flag, r: reRow.prior_decline_reference }));
  }

  // -----------------------------------------------------------------------
  section('SUBMIT — renewal validation');
  // -----------------------------------------------------------------------
  {
    const noLink = await postForm('/api/application/submit', validForm({ mobile: '09175555555', application_category: 'renewal' }));
    check('renewal without linked_borrower_id → 400', noLink.status === 400 && /linked_borrower_id is required/.test(noLink.body.message), JSON.stringify(noLink.body));

    const badLink = await postForm('/api/application/submit', validForm({ mobile: '09175555555', application_category: 'renewal', linked_borrower_id: 'NOPE' }));
    check('renewal with non-existent link → 400', badLink.status === 400 && /does not match/.test(badLink.body.message), JSON.stringify(badLink.body));

    db.applications.push({ id: newId(), reference_id: 'GR8-APPROVED1', phone: '09179999999', status: 'approved', loandisk_borrower_id: 'LD-700' });
    FINSCORE['09175555555'] = { score: 540, normalized: 80, noScore: false };
    const okRenewal = await postForm('/api/application/submit', validForm({ mobile: '09175555555', application_category: 'renewal', linked_borrower_id: 'LD-700' }));
    check('renewal with valid link → success', okRenewal.body.status === 'success', JSON.stringify(okRenewal.body));
    const rnRow = db.applications.find((a) => a.phone === '09175555555' && a.status === 'pending');
    check('renewal fields persisted', rnRow.application_category === 'renewal' && rnRow.linked_borrower_id === 'LD-700', JSON.stringify({ c: rnRow.application_category, l: rnRow.linked_borrower_id }));
  }

  // -----------------------------------------------------------------------
  section('SUBMIT-GROUP — declines + success');
  // -----------------------------------------------------------------------
  {
    const member = (over = {}) => ({ firstName: 'M', lastName: 'X', mobile: '09180000001', dateOfBirth: '1990-01-01', loanAmount: '20000', email: 'm@test.com', ...over });

    const tooFew = await postForm('/api/application/submit-group', {
      loanType: 'group', totalLoanAmount: '40000', groupName: 'G1', paymentTerm: '12',
      members: [member(), member(), member()],
    });
    check('group < 5 members → declined', tooFew.body.status === 'declined' && tooFew.body.reasons[0].includes('at least 5'), JSON.stringify(tooFew.body));

    // Empty members must return a clean decline (member-count guard now runs
    // before the leader deref — previously this 500-crashed).
    const sblEmpty = await postForm('/api/application/submit-group', {
      loanType: 'sbl', totalLoanAmount: '40000', groupName: 'S1', paymentTerm: '12', members: [],
    });
    check('sbl empty members → clean decline (not a crash)', sblEmpty.status === 200 && sblEmpty.body.status === 'declined', JSON.stringify(sblEmpty.body));

    // Real SBL minimum is 1 valid member.
    const sblOk = await postForm('/api/application/submit-group', {
      loanType: 'sbl', totalLoanAmount: '40000', groupName: 'SBL-OK', paymentTerm: '12',
      members: [member({ mobile: '09188888881', loanAmount: '40000' })],
    });
    check('sbl with 1 valid member → success', sblOk.body.status === 'success', JSON.stringify(sblOk.body));

    const badMember = await postForm('/api/application/submit-group', {
      loanType: 'group', totalLoanAmount: '40000', groupName: 'G2', paymentTerm: '12',
      members: [member({ mobile: '09180000010' }), member({ mobile: 'bad' }), member({ loanAmount: '999999', mobile: '09180000012' }),
      member({ dateOfBirth: '2015-01-01', mobile: '09180000013' }), member({ mobile: '09180000014' })],
    });
    check('group per-member errors surfaced', badMember.body.status === 'declined' && badMember.body.reasons.length >= 3, JSON.stringify(badMember.body.reasons));

    const members5 = [0, 1, 2, 3, 4].map((i) => member({ mobile: `0918100000${i}` }));
    FINSCORE['09181000004'] = { noScore: true, score: 0, normalized: 0 }; // one member without score
    const okGroup = await postForm('/api/application/submit-group', {
      loanType: 'group', totalLoanAmount: '100000', groupName: 'GoodGroup', paymentTerm: '12', members: members5,
    });
    check('valid group (5) → success, totalMembers 5', okGroup.body.status === 'success' && okGroup.body.totalMembers === 5, JSON.stringify(okGroup.body));
    const groupRows = db.applications.filter((a) => a.form_data && a.form_data.groupName === 'GoodGroup');
    check('one row per member inserted', groupRows.length === 5, String(groupRows.length));
    const leader = groupRows.find((r) => r.reference_id === okGroup.body.referenceId);
    const coMembers = groupRows.filter((r) => /-M\d+$/.test(r.reference_id));
    check('leader base ref + co-members suffixed -M{i}', leader && coMembers.length === 4, JSON.stringify({ leader: leader && leader.reference_id, co: coMembers.map((c) => c.reference_id) }));
    const zeroScoreMember = groupRows.find((r) => r.phone === '09181000004');
    check('member without FinScore → finscore_raw 0 fallback', zeroScoreMember.finscore_raw === 0, String(zeroScoreMember.finscore_raw));
  }

  // -----------------------------------------------------------------------
  section('PIPELINE — transition guards (direct transitionStage)');
  // -----------------------------------------------------------------------
  const { transitionStage } = pipelineSvc;
  async function expectThrow(name, fn, msgIncludes) {
    try { await fn(); check(name, false, 'did not throw'); }
    catch (e) { check(name, !msgIncludes || e.message.includes(msgIncludes), e.message); }
  }
  {
    // Fresh app at verifier stage dedicated to guard tests.
    FINSCORE['09177777777'] = { score: 540, normalized: 80, noScore: false };
    await postForm('/api/application/submit', validForm({ mobile: '09177777777' }));
    const gId = db.applications.find((a) => a.phone === '09177777777' && a.status === 'pending').id;

    // Wrong role first (still at verifier).
    await expectThrow('verifier→ci_officer blocked for sales_officer role',
      () => transitionStage(gId, 'ci_officer', { id: userId('sales_officer'), roles: ['sales_officer'], full_name: 'so' }, {}),
      'Only verifiers');

    // verifier→ci_officer allowed for verifier
    const adv1 = await transitionStage(gId, 'ci_officer', { id: userId('verifier'), roles: ['verifier'], full_name: 'v' }, {});
    check('verifier→ci_officer allowed for verifier', adv1.stage === 'ci_officer', adv1.stage);

    // Backward move with no guard (ci_officer→sales_officer) is blocked.
    await expectThrow('backward transition blocked (no guard pair)',
      () => transitionStage(gId, 'sales_officer', { id: userId('admin'), roles: ['admin'], full_name: 'a' }, {}),
      'Backward');

    // ci_officer→approver blocked when no CI score yet
    await expectThrow('ci_officer→approver blocked without CI score',
      () => transitionStage(gId, 'approver', { id: userId('ci_officer'), roles: ['ci_officer'], full_name: 'ci' }, {}),
      'CI score');

    // same-stage no-op blocked
    await expectThrow('same-stage transition blocked',
      () => transitionStage(gId, 'ci_officer', { id: userId('admin'), roles: ['admin'], full_name: 'a' }, {}),
      'already at');
  }

  // -----------------------------------------------------------------------
  section('PIPELINE — verifier→sales_officer rework return');
  // -----------------------------------------------------------------------
  {
    // New app freshly at verifier
    FINSCORE['09176666666'] = { score: 540, normalized: 80, noScore: false };
    await postForm('/api/application/submit', validForm({ mobile: '09176666666' }));
    const rwRow = db.applications.find((a) => a.phone === '09176666666' && a.status === 'pending');
    // assign a sales officer so return notification path is exercised
    rwRow.assigned_sales_officer = userId('sales_officer');

    await expectThrow('return without reason blocked',
      () => transitionStage(rwRow.id, 'sales_officer', { id: userId('verifier'), roles: ['verifier'], full_name: 'v' }, {}),
      'Return reason');

    const ret = await transitionStage(rwRow.id, 'sales_officer', { id: userId('verifier'), roles: ['verifier'], full_name: 'v' }, { return_reason: 'Missing payslip' });
    check('verifier→sales_officer allowed with reason', ret.stage === 'sales_officer', ret.stage);
    const after = db.applications.find((a) => a.id === rwRow.id);
    check('returned_count incremented + reason recorded', after.returned_count === 1 && after.last_return_reason === 'Missing payslip', JSON.stringify({ c: after.returned_count, r: after.last_return_reason }));
  }

  // -----------------------------------------------------------------------
  section('PIPELINE — sales_officer stage guards (advance + SO decision)');
  // -----------------------------------------------------------------------
  // Helper: land an application at the sales_officer stage via a verifier return.
  async function freshAtSO(phone) {
    FINSCORE[phone] = { score: 540, normalized: 80, noScore: false };
    await postForm('/api/application/submit', validForm({ mobile: phone }));
    const row = db.applications.find((a) => a.phone === phone && a.status === 'pending');
    row.assigned_sales_officer = userId('sales_officer');
    await transitionStage(row.id, 'sales_officer', { id: userId('verifier'), roles: ['verifier'], full_name: 'v' }, { return_reason: 'rework' });
    return row.id;
  }
  {
    // sales_officer->verifier allowed when an SO is assigned
    const aId = await freshAtSO('09201000001');
    const adv = await transitionStage(aId, 'verifier', { id: userId('sales_officer'), roles: ['sales_officer'], full_name: 'so' }, {});
    check('sales_officer→verifier allowed (SO assigned)', adv.stage === 'verifier', adv.stage);

    // sales_officer->verifier blocked when no SO assigned
    const bId = await freshAtSO('09201000002');
    db.applications.find((a) => a.id === bId).assigned_sales_officer = null;
    await expectThrow('sales_officer→verifier blocked without assigned SO',
      () => transitionStage(bId, 'verifier', { id: userId('sales_officer'), roles: ['sales_officer'], full_name: 'so' }, {}),
      'must be assigned');

    // sales_officer->approver SO-decision validation
    const cId = await freshAtSO('09201000003');
    await expectThrow('SO decision without so_decision → blocked',
      () => transitionStage(cId, 'approver', { id: userId('sales_officer'), roles: ['sales_officer'], full_name: 'so' }, {}),
      'so_decision is required');
    await expectThrow('SO decision with invalid value → blocked',
      () => transitionStage(cId, 'approver', { id: userId('sales_officer'), roles: ['sales_officer'], full_name: 'so' }, { so_decision: 'maybe' }),
      'confirm or decline');
    const soDec = await transitionStage(cId, 'approver', { id: userId('sales_officer'), roles: ['sales_officer'], full_name: 'so' }, { so_decision: 'confirm' });
    check('sales_officer→approver with confirm → allowed + so_decision written',
      soDec.stage === 'approver' && soDec.so_decision === 'confirm' && !!soDec.so_decision_at,
      JSON.stringify({ st: soDec.stage, d: soDec.so_decision }));
  }

  // -----------------------------------------------------------------------
  section('CI SCORE — tiers, reapplication bonus, auto-advance');
  // -----------------------------------------------------------------------
  async function freshAtCI(phone, finNorm) {
    FINSCORE[phone] = { score: 540, normalized: finNorm, noScore: false };
    await postForm('/api/application/submit', validForm({ mobile: phone }));
    const row = db.applications.find((a) => a.phone === phone && a.status === 'pending');
    await transitionStage(row.id, 'ci_officer', { id: userId('verifier'), roles: ['verifier'], full_name: 'v' }, {});
    return row.id;
  }
  {
    // approved: fin 90 + ci 80 → 85.0 → 'approved'
    const aId = await freshAtCI('09190000001', 90);
    const aRes = await jsonReq('PATCH', `/api/admin/applications/${aId}/ci-score`, { ci_score: 40, ...REPAY }, adminSecretH); // ci 40/50=80
    check('tier boundary ≥85 → approved', aRes.body.final_score === 85 && aRes.body.tier === 'approved', JSON.stringify({ s: aRes.body.final_score, t: aRes.body.tier }));
    check('ci-score auto-advanced ci_officer→approver', db.applications.find((a) => a.id === aId).stage === 'approver', db.applications.find((a) => a.id === aId).stage);

    // tier_b: fin 70 + ci 70 → 70.0 → 'tier_b'
    const bId = await freshAtCI('09190000002', 70);
    const bRes = await jsonReq('PATCH', `/api/admin/applications/${bId}/ci-score`, { ci_score: 35, ...REPAY }, adminSecretH); // ci 70
    check('tier boundary ≥70 → tier_b', bRes.body.final_score === 70 && bRes.body.tier === 'tier_b', JSON.stringify({ s: bRes.body.final_score, t: bRes.body.tier }));

    // declined: fin 40 + ci 40 → 40 → 'declined'
    const dId = await freshAtCI('09190000003', 40);
    const dRes = await jsonReq('PATCH', `/api/admin/applications/${dId}/ci-score`, { ci_score: 20, ...REPAY }, adminSecretH); // ci 40
    check('final < 70 → tier declined', dRes.body.final_score === 40 && dRes.body.tier === 'declined', JSON.stringify({ s: dRes.body.final_score, t: dRes.body.tier }));

    // reapplication bonus +10: fin 70 + ci 70 = 70, +10 = 80 → tier_b
    const rId = await freshAtCI('09190000004', 70);
    const rRes = await jsonReq('PATCH', `/api/admin/applications/${rId}/ci-score`, { ci_score: 35, ci_form_data: { is_reapplication: true }, ...REPAY }, adminSecretH);
    check('reapplication bonus +10 applied', rRes.body.final_score === 80, JSON.stringify(rRes.body.final_score));

    // cap at 100: fin 100 + ci 100 = 100, +10 → capped 100
    const cId = await freshAtCI('09190000005', 100);
    const cRes = await jsonReq('PATCH', `/api/admin/applications/${cId}/ci-score`, { ci_score: 50, ci_form_data: { is_reapplication: true }, ...REPAY }, adminSecretH);
    check('final_score capped at 100', cRes.body.final_score === 100, JSON.stringify(cRes.body.final_score));

    // Repayment field validation (CI stage): two_times requires exactly 2 distinct dates.
    const vId = await freshAtCI('09190000006', 40);
    const badFreq = await jsonReq('PATCH', `/api/admin/applications/${vId}/ci-score`, { ci_score: 40, payment_frequency: 'two_times', salary_payout_dates: [15], repayment_cycle: '15' }, adminSecretH);
    check('ci-score bad payout count → 400', badFreq.status === 400 && /exactly 2 salary_payout_dates/.test(badFreq.body.error), JSON.stringify(badFreq.body));
    const missingCycle = await jsonReq('PATCH', `/api/admin/applications/${vId}/ci-score`, { ci_score: 40, payment_frequency: 'one_time', salary_payout_dates: [15] }, adminSecretH);
    check('ci-score missing repayment_cycle → 400', missingCycle.status === 400 && /repayment_cycle is required/.test(missingCycle.body.error), JSON.stringify(missingCycle.body));
  }

  // -----------------------------------------------------------------------
  section('CI SCORE — SBL honorarium_date requirement');
  // -----------------------------------------------------------------------
  {
    // SBL row parked at ci_officer (SBL apps originate from /submit-group; push
    // a representative row directly to isolate the honorarium_date validation).
    const sblId = newId();
    db.applications.push({
      id: sblId, reference_id: 'GR8-SBL-HON', phone: '09196666666',
      loan_type: 'sbl', status: 'pending', stage: 'ci_officer',
      finscore_normalized: 80, loan_amount: 30000, loan_term: 12, stage_history: []
    });

    // SBL without honorarium_date → 400 (required only for SBL)
    const missing = await jsonReq('PATCH', `/api/admin/applications/${sblId}/ci-score`, { ci_score: 40, ...REPAY }, adminSecretH);
    check('SBL ci-score without honorarium_date → 400', missing.status === 400 && /honorarium_date is required for SBL/.test(missing.body.error), JSON.stringify(missing.body));

    // out-of-range honorarium_date → 400
    const bad = await jsonReq('PATCH', `/api/admin/applications/${sblId}/ci-score`, { ci_score: 40, ...REPAY, honorarium_date: 40 }, adminSecretH);
    check('SBL honorarium_date out of range (40) → 400', bad.status === 400 && /honorarium_date is required for SBL/.test(bad.body.error), JSON.stringify(bad.body));

    // valid day-of-month → 200, persisted
    const ok = await jsonReq('PATCH', `/api/admin/applications/${sblId}/ci-score`, { ci_score: 40, ...REPAY, honorarium_date: 15 }, adminSecretH);
    check('SBL ci-score with honorarium_date 15 → 200', ok.status === 200, JSON.stringify({ s: ok.status, e: ok.body.error }));
    check('honorarium_date persisted on row', db.applications.find((a) => a.id === sblId).honorarium_date === 15, String(db.applications.find((a) => a.id === sblId).honorarium_date));

    // SBL needs ONLY honorarium_date — no salary_payout_dates / frequency / cycle.
    const sbl2 = newId();
    db.applications.push({
      id: sbl2, reference_id: 'GR8-SBL-HON2', phone: '09196667777',
      loan_type: 'sbl', status: 'pending', stage: 'ci_officer',
      finscore_normalized: 80, loan_amount: 30000, loan_term: 12, stage_history: []
    });
    const honOnly = await jsonReq('PATCH', `/api/admin/applications/${sbl2}/ci-score`, { ci_score: 40, honorarium_date: 20 }, adminSecretH);
    check('SBL ci-score with ONLY honorarium_date (no salary fields) → 200', honOnly.status === 200, JSON.stringify({ s: honOnly.status, e: honOnly.body.error }));
  }

  // -----------------------------------------------------------------------
  section('FIRST REPAYMENT — per-product calc (services/repayment.js)');
  // -----------------------------------------------------------------------
  {
    const { calculateFirstRepaymentDate: frd } = require('../services/repayment');
    check('AKAP release+7 (Jun10→Jun17)', frd('2026-06-10', 'akap', null, null) === '2026-06-17', frd('2026-06-10', 'akap', null, null));
    check('SME +1mo same day (Jun10→Jul10)', frd('2026-06-10', 'sme', null, null) === '2026-07-10', frd('2026-06-10', 'sme', null, null));
    check('SME EOM (Jan31→Feb28)', frd('2026-01-31', 'sme', null, null) === '2026-02-28', frd('2026-01-31', 'sme', null, null));
    check('SME EOM leap (Jan31→Feb29)', frd('2028-01-31', 'sme', null, null) === '2028-02-29', frd('2028-01-31', 'sme', null, null));
    check('PL 15-30 rel18 → Jul15', frd('2026-06-18', 'personal', '15-30', [15, 30]) === '2026-07-15', frd('2026-06-18', 'personal', '15-30', [15, 30]));
    check('PL 15-30 rel2 (thr 17th) → Jun30', frd('2026-06-02', 'personal', '15-30', [15, 30]) === '2026-06-30', frd('2026-06-02', 'personal', '15-30', [15, 30]));
    check('PL cycle31 rel20 → Jul31 (EOM)', frd('2026-06-20', 'personal', '31', [31]) === '2026-07-31', frd('2026-06-20', 'personal', '31', [31]));
    check('SBL honorarium=15 rel10 → Jul15', frd('2026-06-10', 'sbl', null, [15]) === '2026-07-15', frd('2026-06-10', 'sbl', null, [15]));
  }

  // -----------------------------------------------------------------------
  section('CI SCORE — AKAP/SME skip salary validation');
  // -----------------------------------------------------------------------
  {
    const skipCases = [['akap', '09197770001'], ['sme', '09197770002']];
    for (const [lt, phone] of skipCases) {
      const id = newId();
      db.applications.push({
        id, reference_id: `GR8-${lt.toUpperCase()}`, phone,
        loan_type: lt, status: 'pending', stage: 'ci_officer',
        finscore_normalized: 80, loan_amount: 30000, loan_term: 12, stage_history: []
      });
      // No payment_frequency / salary_payout_dates / repayment_cycle sent.
      const res = await jsonReq('PATCH', `/api/admin/applications/${id}/ci-score`, { ci_score: 40 }, adminSecretH);
      check(`${lt} ci-score without salary fields → 200`, res.status === 200, JSON.stringify({ s: res.status, e: res.body.error }));
    }
  }

  // -----------------------------------------------------------------------
  section('APPROVE — reaches LPO, Loandisk payload asserted (CUT before real call)');
  // -----------------------------------------------------------------------
  let approveId;
  {
    FINSCORE['09191111111'] = { score: 540, normalized: 90, noScore: false };
    await postForm('/api/application/submit', validForm({ mobile: '09191111111', loanAmount: '25000', paymentTerm: '12' }));
    const row = db.applications.find((a) => a.phone === '09191111111' && a.status === 'pending');
    approveId = row.id;
    await transitionStage(approveId, 'ci_officer', { id: userId('verifier'), roles: ['verifier'], full_name: 'v' }, {});
    await jsonReq('PATCH', `/api/admin/applications/${approveId}/ci-score`, { ci_score: 40, ...REPAY }, adminSecretH); // → approver

    const before = db.applications.find((a) => a.id === approveId).stage;
    check('at approver stage before approve', before === 'approver', before);

    const ap = await jsonReq('PATCH', `/api/admin/applications/${approveId}/approve`, { loan_release_date: RELEASE_DATE }, authH('approver'));
    check('approve → 200 status approved', ap.status === 200 && ap.body.status === 'approved', JSON.stringify(ap.body));
    const after = db.applications.find((a) => a.id === approveId);
    check('reached loan_processing_officer stage', after.stage === 'loan_processing_officer', after.stage);
    check('application status = approved', after.status === 'approved', after.status);

    // The cut point: assert WHAT would be sent to Loandisk — never actually sent.
    check('Loandisk createBorrower spy hit exactly once', loandiskCalls.createBorrower.length === 1, String(loandiskCalls.createBorrower.length));
    const loanInput = loandiskCalls.createLoan[loandiskCalls.createLoan.length - 1];
    check('createLoan payload: principal 25000', Number(loanInput.principal) === 25000, JSON.stringify(loanInput.principal));
    check('createLoan payload: duration 12', Number(loanInput.duration_months) === 12, JSON.stringify(loanInput.duration_months));
    check('createLoan payload: personal default rate 3.5', Number(loanInput.interest_rate) === 3.5, JSON.stringify(loanInput.interest_rate));
    // repayment_cycle '15-30' (2-payout) overrides the product default -> semi-monthly 3413.
    check('createLoan payload: cycle-derived scheme 3413 (semi-monthly)', Number(loanInput.payment_scheme_id) === 3413, JSON.stringify(loanInput.payment_scheme_id));
    check('createLoan payload: released_date mm/dd/yyyy', loanInput.released_date === '06/10/2026', String(loanInput.released_date));
    // release 2026-06-10, cycle 15-30: threshold = 06-25, first snapped payout strictly after = 06-30.
    check('createLoan payload: first_repayment_date computed', loanInput.first_repayment_date === '2026-06-30', String(loanInput.first_repayment_date));
    check('first_repayment_date persisted on row', after.first_repayment_date === '2026-06-30', String(after.first_repayment_date));
    check('fee snapshot persisted (net_disbursement)', after.net_disbursement_amount === 25000 - 1250 - 250, String(after.net_disbursement_amount));
  }

  // -----------------------------------------------------------------------
  section('APPROVE — discount gate + adjusted-terms (no Loandisk push)');
  // -----------------------------------------------------------------------
  {
    // discount below default without reason → blocked
    FINSCORE['09192222222'] = { score: 540, normalized: 90, noScore: false };
    await postForm('/api/application/submit', validForm({ mobile: '09192222222' }));
    const r = db.applications.find((a) => a.phone === '09192222222' && a.status === 'pending');
    await transitionStage(r.id, 'ci_officer', { id: userId('verifier'), roles: ['verifier'], full_name: 'v' }, {});
    await jsonReq('PATCH', `/api/admin/applications/${r.id}/ci-score`, { ci_score: 40, ...REPAY }, adminSecretH);

    // loan_release_date required at the Loandisk push chokepoint.
    const noRelease = await jsonReq('PATCH', `/api/admin/applications/${r.id}/approve`, {}, authH('approver'));
    check('approve without loan_release_date → 400', noRelease.status === 400 && /loan_release_date is required/.test(noRelease.body.error), JSON.stringify(noRelease.body));
    check('missing-release approval did NOT advance stage', db.applications.find((a) => a.id === r.id).stage === 'approver', db.applications.find((a) => a.id === r.id).stage);

    const denied = await jsonReq('PATCH', `/api/admin/applications/${r.id}/approve`, { interest_rate: 2.0, loan_release_date: RELEASE_DATE }, authH('approver'));
    check('rate below default w/o discount_reason → 400', denied.status === 400 && /discount_reason is required/.test(denied.body.error), JSON.stringify(denied.body));
    check('blocked approval did NOT advance stage', db.applications.find((a) => a.id === r.id).stage === 'approver', db.applications.find((a) => a.id === r.id).stage);
    const callsBefore = loandiskCalls.createLoan.length;

    // adjusted amount differs → pending_sa_confirmation, NO Loandisk push
    const adj = await jsonReq('PATCH', `/api/admin/applications/${r.id}/approve`, { adjusted_amount: 30000 }, authH('approver'));
    check('adjusted terms → pending_sa_confirmation', adj.body.status === 'pending_sa_confirmation', JSON.stringify(adj.body));
    check('no Loandisk push on adjusted-terms branch', loandiskCalls.createLoan.length === callsBefore, 'createLoan was called');

    // reject-terms → back to pending/approver
    const rej = await jsonReq('PATCH', `/api/admin/applications/${r.id}/reject-terms`, { note: 'Amount too high for income' }, authH('approver'));
    check('reject-terms → back to pending @ approver', rej.body.status === 'pending' && rej.body.stage === 'approver', JSON.stringify({ s: rej.body.status, st: rej.body.stage }));

    // confirm-terms happy path: adjusted 30000 → SA confirms → reaches LPO with
    // the OVERRIDDEN principal (30000, not the original 25000). This exercises
    // meta.principal/duration override in executeLoandiskApproval.
    FINSCORE['09192223333'] = { score: 540, normalized: 90, noScore: false };
    await postForm('/api/application/submit', validForm({ mobile: '09192223333', loanAmount: '25000', paymentTerm: '12' }));
    const ct = db.applications.find((a) => a.phone === '09192223333' && a.status === 'pending');
    await transitionStage(ct.id, 'ci_officer', { id: userId('verifier'), roles: ['verifier'], full_name: 'v' }, {});
    await jsonReq('PATCH', `/api/admin/applications/${ct.id}/ci-score`, { ci_score: 40, ...REPAY }, adminSecretH);
    const ctAdj = await jsonReq('PATCH', `/api/admin/applications/${ct.id}/approve`, { adjusted_amount: 30000, loan_release_date: RELEASE_DATE }, authH('approver'));
    check('confirm-terms setup → pending_sa_confirmation', ctAdj.body.status === 'pending_sa_confirmation', JSON.stringify(ctAdj.body));
    const ctConfirm = await jsonReq('PATCH', `/api/admin/applications/${ct.id}/confirm-terms`, {}, authH('approver'));
    check('confirm-terms → reaches loan_processing_officer', ctConfirm.body.stage === 'loan_processing_officer', JSON.stringify({ st: ctConfirm.body.stage }));
    const ctLoan = loandiskCalls.createLoan[loandiskCalls.createLoan.length - 1];
    check('confirm-terms used overridden principal 30000 (not 25000)', Number(ctLoan.principal) === 30000, JSON.stringify(ctLoan.principal));
  }

  // -----------------------------------------------------------------------
  section('APPROVE — manual override guardrail');
  // -----------------------------------------------------------------------
  {
    const shortReason = await jsonReq('PATCH', `/api/admin/applications/${approveId}/override`, { override_reason: 'short' }, authH('approver'));
    check('override reason < 10 chars → 400', shortReason.status === 400 && /at least 10/.test(shortReason.body.error), JSON.stringify(shortReason.body));

    // approveId has a valid FinScore (normalized 90, raw 540) → override forbidden
    const present = await jsonReq('PATCH', `/api/admin/applications/${approveId}/override`, { override_reason: 'valid long reason here' }, authH('approver'));
    check('override blocked when FinScore present → 403', present.status === 403 && /only allowed when FinScore is missing/.test(present.body.error), JSON.stringify(present.body));

    // application with raw 0 → override allowed
    FINSCORE['09193333333'] = { noScore: true, score: 0, normalized: 0 };
    await postForm('/api/application/submit', validForm({ mobile: '09193333333' }));
    const noScoreRow = db.applications.find((a) => a.phone === '09193333333' && a.status === 'pending');
    const ok = await jsonReq('PATCH', `/api/admin/applications/${noScoreRow.id}/override`, { override_reason: 'No telco data, manual KYC done' }, authH('approver'));
    check('override allowed when FinScore missing → 200', ok.status === 200 && ok.body.manual_override === true && ok.body.stage === 'approver', JSON.stringify({ s: ok.status, mo: ok.body.manual_override, st: ok.body.stage }));
  }

  // -----------------------------------------------------------------------
  section('APPROVER — decline branch');
  // -----------------------------------------------------------------------
  {
    FINSCORE['09194444444'] = { score: 540, normalized: 90, noScore: false };
    await postForm('/api/application/submit', validForm({ mobile: '09194444444' }));
    const r = db.applications.find((a) => a.phone === '09194444444' && a.status === 'pending');
    await transitionStage(r.id, 'ci_officer', { id: userId('verifier'), roles: ['verifier'], full_name: 'v' }, {});
    await jsonReq('PATCH', `/api/admin/applications/${r.id}/ci-score`, { ci_score: 40, ...REPAY }, adminSecretH);

    await expectThrow('decline without reason blocked',
      () => transitionStage(r.id, 'declined', { id: userId('approver'), roles: ['approver'], full_name: 'a' }, {}),
      'Decline reason');

    const dec = await transitionStage(r.id, 'declined', { id: userId('approver'), roles: ['approver'], full_name: 'a' }, { decline_reason: 'Below threshold' });
    check('approver→declined sets status declined', dec.stage === 'declined' && db.applications.find((a) => a.id === r.id).status === 'declined', JSON.stringify({ st: dec.stage }));
  }

  // -----------------------------------------------------------------------
  section('APPROVE — declined-tier supervisor override gate');
  // -----------------------------------------------------------------------
  {
    // Build a tier:'declined' app parked at the approver stage.
    // finNorm 90 + ci 20 (→ci_norm 40): final = 90*.5 + 40*.5 = 65 < 70 → declined.
    FINSCORE['09195555555'] = { score: 540, normalized: 90, noScore: false };
    await postForm('/api/application/submit', validForm({ mobile: '09195555555' }));
    const r = db.applications.find((a) => a.phone === '09195555555' && a.status === 'pending');
    await transitionStage(r.id, 'ci_officer', { id: userId('verifier'), roles: ['verifier'], full_name: 'v' }, {});
    const ci = await jsonReq('PATCH', `/api/admin/applications/${r.id}/ci-score`, { ci_score: 20, ...REPAY }, adminSecretH);
    check('setup: tier declined parked at approver', ci.body.tier === 'declined' && db.applications.find((a) => a.id === r.id).stage === 'approver', JSON.stringify({ t: ci.body.tier }));

    // 1. declined + no override flag → 403 OVERRIDE_FORBIDDEN (even for a supervisor)
    const noOv = await jsonReq('PATCH', `/api/admin/applications/${r.id}/approve`, { loan_release_date: RELEASE_DATE }, authH('approver'));
    check('declined approve w/o override → 403 OVERRIDE_FORBIDDEN', noOv.status === 403 && noOv.body.error?.code === 'OVERRIDE_FORBIDDEN', JSON.stringify(noOv.body));
    check('blocked declined approve did NOT advance stage', db.applications.find((a) => a.id === r.id).stage === 'approver', db.applications.find((a) => a.id === r.id).stage);

    // 2. declined + override by admin (non-supervisor, intentionally excluded) → 403
    const adminOv = await jsonReq('PATCH', `/api/admin/applications/${r.id}/approve`, { override: true, loan_release_date: RELEASE_DATE }, authH('admin'));
    check('declined override by admin (non-supervisor) → 403', adminOv.status === 403 && adminOv.body.error?.code === 'OVERRIDE_FORBIDDEN', JSON.stringify(adminOv.body));
    check('admin override did NOT advance stage', db.applications.find((a) => a.id === r.id).stage === 'approver', db.applications.find((a) => a.id === r.id).stage);

    // 3. declined + override by approver (supervisor) → 200, reaches LPO
    const supOv = await jsonReq('PATCH', `/api/admin/applications/${r.id}/approve`, { override: true, loan_release_date: RELEASE_DATE }, authH('approver'));
    check('declined override by approver (supervisor) → 200 approved', supOv.status === 200 && supOv.body.status === 'approved', JSON.stringify(supOv.body));
    check('override approve reached loan_processing_officer', db.applications.find((a) => a.id === r.id).stage === 'loan_processing_officer', db.applications.find((a) => a.id === r.id).stage);
  }

  // -----------------------------------------------------------------------
  section('AUTH / RBAC');
  // -----------------------------------------------------------------------
  {
    const noAuth = await jsonReq('PATCH', `/api/admin/applications/${approveId}/approve`, {}, {});
    check('admin route without auth → 401', noAuth.status === 401, String(noAuth.status));

    const wrongRole = await jsonReq('PATCH', `/api/admin/applications/${approveId}/approve`, {}, authH('verifier'));
    check('approve with verifier role → 403', wrongRole.status === 403, String(wrongRole.status));

    const ciWrong = await jsonReq('GET', '/api/ci/applications', null, authH('sales_officer'));
    check('CI route with sales_officer role → 403', ciWrong.status === 403, String(ciWrong.status));

    // ci.js (CI-agent route) happy path: validates + stores repayment fields,
    // and accepts the approver role (Part 6). Distinct route from admin.js.
    const ciId = await freshAtCI('09190000007', 80);
    const ciOk = await jsonReq('PATCH', `/api/ci/applications/${ciId}/ci-score`, { ci_score: 40, ...REPAY }, authH('approver'));
    check('CI-agent route ci-score (approver) → 200', ciOk.status === 200, String(ciOk.status));
    const ciRow = db.applications.find((a) => a.id === ciId);
    check('CI-agent route stored repayment_cycle', ciRow.repayment_cycle === '15-30', String(ciRow.repayment_cycle));
    const ciBad = await jsonReq('PATCH', `/api/ci/applications/${ciId}/ci-score`, { ci_score: 40, payment_frequency: 'two_times', salary_payout_dates: [15, 15], repayment_cycle: '15-15' }, authH('approver'));
    check('CI-agent route rejects non-distinct dates → 400', ciBad.status === 400 && /distinct/.test(ciBad.body.error), JSON.stringify(ciBad.body));
  }

  // -----------------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------------
  console.log(`\n\x1b[1mRESULT:\x1b[0m ${pass} passed, ${fail} failed`);
  if (fail) console.log('Failed:', failures.join(' | '));
  server.close();
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error('HARNESS CRASH:', e); if (server) server.close(); process.exit(2); });
