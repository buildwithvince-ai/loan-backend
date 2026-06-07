'use strict';

// ---------------------------------------------------------------------------
// LIVE schema-drift smoke test — hits REAL Supabase (prod).
//
// Purpose: the mocked e2e harness (e2e-flow.test.js) cannot catch schema drift
// because its Supabase mock returns {error:null} for every write. This script
// runs the actual submit insert + ci-score update + a stage transition against
// the REAL database to prove the columns the code writes exist in prod.
//
// CUT BEFORE LOANDISK: stops at the approver stage. Never calls approve
// (approver->LPO is the Loandisk push).
//
// Side effects controlled:
//   - FinScore  : MOCKED to a success so the insert actually runs (a real 0917
//                 lookup would 422 and skip the insert).
//   - Email     : MOCKED no-op so real ZeptoMail team notifications don't fire.
//   - Supabase  : REAL. One row is created and DELETED BY EXACT ID at the end
//                 (NOT the broad test-cleanup?prefix=0917 endpoint, which would
//                 delete real applicants on Globe 0917 numbers).
//
// Run: node tests/smoke-live.test.js
// ---------------------------------------------------------------------------

require('dotenv').config();

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY in .env — cannot run live smoke.');
  process.exit(2);
}

// Mock FinScore (force a success) + email (silence) BEFORE requiring routes.
const finscoreSvc = require('../services/finscore');
finscoreSvc.getScore = async () => ({ score: 540, normalized: 80, riskBand: '21', noScore: false });

const emailSvc = require('../services/email');
for (const fn of ['sendEmail', 'notifySalesOfficer', 'notifyTeamByRole', 'notifySOReturn',
  'notifySODecision', 'sendSOConfirmationRequest', 'notifyApproverSODecision', 'sendProblemReport']) {
  emailSvc[fn] = async () => {};
}

const { supabase } = require('../services/supabase'); // REAL client
const { transitionStage } = require('../services/pipeline');

const express = require('express');
const app = express();
app.use(express.json());
app.use('/api/application', require('../routes/application'));
app.use('/api/admin', require('../routes/admin'));

const PHONE = '09170000777';
const ADMIN_SECRET = process.env.ADMIN_SECRET;

let pass = 0, fail = 0, server, BASE, createdId = null;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function cleanup() {
  if (!createdId) return;
  const { error } = await supabase.from('applications').delete().eq('id', createdId);
  if (error) console.error('  CLEANUP FAILED — delete row manually, id =', createdId, error.message);
  else console.log(`  \x1b[36mcleaned up row ${createdId}\x1b[0m`);
}

async function run() {
  await new Promise((r) => { server = app.listen(0, r); });
  BASE = `http://127.0.0.1:${server.address().port}`;

  // Guard: don't collide with a real pending application on this phone.
  const { data: pre } = await supabase.from('applications').select('id').eq('phone', PHONE).eq('status', 'pending');
  if (pre && pre.length) {
    console.error(`A real pending application already exists on ${PHONE}. Aborting to avoid touching real data.`);
    server.close();
    process.exit(2);
  }

  console.log('\n\x1b[1mLIVE SMOKE — real Supabase (cut before Loandisk)\x1b[0m');

  // 1. Submit — exercises the full INSERT payload against the real schema.
  const fd = new FormData();
  const form = {
    firstName: 'SchemaSmoke', lastName: 'DELETEME', mobile: PHONE, email: 'smoke@gr8.test',
    dateOfBirth: '1990-01-15', loanType: 'personal', loanAmount: '25000', monthlyIncome: '20000',
    paymentTerm: '12', consentAgreed: 'true', application_category: 'new',
  };
  for (const [k, v] of Object.entries(form)) fd.append(k, v);
  const submitRes = await fetch(BASE + '/api/application/submit', { method: 'POST', body: fd });
  const submitBody = await submitRes.json().catch(() => ({}));
  check('submit insert accepted by real schema', submitRes.status === 200 && submitBody.status === 'success', JSON.stringify(submitBody));

  if (submitBody.status !== 'success') { await cleanup(); server.close(); return finish(); }

  const { data: row, error: rowErr } = await supabase
    .from('applications').select('*').eq('reference_id', submitBody.referenceId).single();
  check('inserted row readable from real DB', !rowErr && !!row, rowErr && rowErr.message);
  if (!row) { server.close(); return finish(); }
  createdId = row.id;

  // Verify the columns the submit code writes actually persisted (drift check).
  const expectedCols = ['prior_decline_flag', 'application_category', 'consent_agreed', 'finscore_normalized', 'stage', 'status'];
  const missing = expectedCols.filter((c) => !(c in row));
  check('all submit columns present in row', missing.length === 0, 'missing: ' + missing.join(', '));
  check('row persisted as pending @ verifier', row.status === 'pending' && row.stage === 'verifier', `${row.status}/${row.stage}`);

  // 2. Transition verifier->ci_officer (real UPDATE: stage + stage_history jsonb).
  const sysUser = { id: 'admin-secret', roles: ['admin', 'super_admin'], full_name: 'Smoke Admin' };
  let advanced = false;
  try {
    const upd = await transitionStage(createdId, 'ci_officer', sysUser, {});
    advanced = upd.stage === 'ci_officer';
  } catch (e) { console.error('  transition error:', e.message); }
  check('verifier->ci_officer UPDATE accepted (stage_history jsonb)', advanced);

  // 3. CI score via real admin route (UPDATE: ci_score/ci_normalized/final_score/tier).
  if (ADMIN_SECRET) {
    const ciRes = await fetch(BASE + `/api/admin/applications/${createdId}/ci-score`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-admin-secret': ADMIN_SECRET },
      // Personal loan_type → repayment fields required by validateCiRepaymentFields.
      body: JSON.stringify({
        ci_score: 40,
        payment_frequency: 'one_time',
        salary_payout_dates: [15],
        repayment_cycle: 'monthly',
      }),
    });
    const ciBody = await ciRes.json().catch(() => ({}));
    check('ci-score UPDATE accepted by real schema', ciRes.status === 200 && ciBody.final_score === 80 && ciBody.tier === 'tier_b', JSON.stringify(ciBody).slice(0, 200));

    const { data: after } = await supabase.from('applications').select('stage, status, final_score, tier').eq('id', createdId).single();
    check('ci-score auto-advanced to approver (cut point — no Loandisk)', after && after.stage === 'approver', after && after.stage);
  } else {
    console.log('  \x1b[33m• ADMIN_SECRET not in .env — skipped ci-score HTTP step\x1b[0m');
  }

  await cleanup();
  server.close();
  finish();
}

function finish() {
  console.log(`\n\x1b[1mRESULT:\x1b[0m ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

run().catch(async (e) => {
  console.error('SMOKE CRASH:', e);
  await cleanup();
  if (server) server.close();
  process.exit(2);
});
