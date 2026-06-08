'use strict';

// ---------------------------------------------------------------------------
// Borrower search — backs the internal renewal flow.
// Source: applications table, scoped to rows that already have a Loandisk
// borrower id (i.e. previously approved). Search is OR-matched on full_name
// (case-insensitive prefix/contains) and phone (prefix). Returns max 10 rows.
//
// AUTH (H1, 2026-06-08): this returns customer PII (name + phone) and used to
// be public — anyone on the internet could enumerate borrowers on a 2-char
// query. Now requires a valid staff JWT. Rate-limited by the parent mount.
// ---------------------------------------------------------------------------

const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabase');
const { verifyToken, requireRole } = require('../middleware/auth');

const MIN_QUERY_LENGTH = 2;
const MAX_RESULTS = 10;

const STAFF_ROLES = ['super_admin', 'admin', 'approver', 'verifier', 'ci_officer', 'sales_officer', 'loan_processing_officer'];

router.use(verifyToken, requireRole(...STAFF_ROLES));

router.get('/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < MIN_QUERY_LENGTH) {
      return res.status(400).json({ error: `Query must be at least ${MIN_QUERY_LENGTH} characters` });
    }

    // Escape PostgREST `or()` filter wildcards so search "%foo%" doesn't break.
    const safeQ = q.replace(/[,()*]/g, '');
    const filter = `full_name.ilike.%${safeQ}%,phone.ilike.${safeQ}%`;

    const { data, error } = await supabase
      .from('applications')
      .select('id, full_name, phone, loandisk_borrower_id')
      .not('loandisk_borrower_id', 'is', null)
      .or(filter)
      .limit(MAX_RESULTS);

    if (error) throw error;

    // Dedupe by loandisk_borrower_id — same borrower may have multiple rows.
    const seen = new Set();
    const unique = [];
    for (const row of data || []) {
      const key = row.loandisk_borrower_id;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(row);
    }

    return res.json(unique);
  } catch (error) {
    console.error('[borrowers/search] error:', error.message);
    return res.status(500).json({ error: 'Search failed' });
  }
});

module.exports = router;
