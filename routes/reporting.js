'use strict';

const express = require('express');
const { supabase } = require('../services/supabase');
const { verifyToken, requireRole } = require('../middleware/auth');
const { PERIODS, buildOverview, buildDashboard } = require('../services/reporting');

const router = express.Router();

// Management data: admin + super_admin only (operator decision 2026-09-30). Enforced
// here for the whole router; the frontend lock on the Reporting menu is cosmetic.
router.use(verifyToken, requireRole('admin', 'super_admin'));

// Only the columns reporting reads. No form_data, documents, or CI form payloads.
const APP_COLUMNS = [
  'id',
  'reference_id',
  'full_name',
  'loan_type',
  'loan_amount',
  'status',
  'stage',
  'submitted_at',
  'reviewed_at',
  'final_score',
  'tier',
  'ci_score',
  'assigned_sales_officer',
  'stage_history',
  'loan_release_date',
  'loan_released_at',
  'first_repayment_date',
  'num_of_repayments',
  'payment_scheme_id',
  'total_interest_amount',
].join(',');

async function fetchAll(table, columns) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
}

async function loadInputs() {
  const [applications, staff] = await Promise.all([
    fetchAll('applications', APP_COLUMNS),
    fetchAll('admin_users', 'id,full_name,roles,is_active,created_at'),
  ]);
  return { applications, staff };
}

// GET /api/reporting/overview?period=30d|90d|12m
router.get('/overview', async (req, res) => {
  const period = req.query.period || '90d';
  if (!PERIODS[period]) {
    return res
      .status(400)
      .json({ error: `period must be one of: ${Object.keys(PERIODS).join(', ')}` });
  }
  try {
    const inputs = await loadInputs();
    return res.json(buildOverview({ ...inputs, period }));
  } catch (err) {
    console.error('[reporting/overview] failed', { period, error: err.message });
    return res.status(500).json({ error: 'Failed to build report' });
  }
});

// GET /api/reporting/dashboard
router.get('/dashboard', async (req, res) => {
  try {
    const inputs = await loadInputs();
    return res.json(buildDashboard(inputs));
  } catch (err) {
    console.error('[reporting/dashboard] failed', { error: err.message });
    return res.status(500).json({ error: 'Failed to build dashboard' });
  }
});

module.exports = router;
