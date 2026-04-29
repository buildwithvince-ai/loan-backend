'use strict';

// ---------------------------------------------------------------------------
// Public borrower search — used by renewal flow on the loan form.
// Source: applications table, scoped to rows that already have a Loandisk
// borrower id (i.e. previously approved). Search is OR-matched on full_name
// (case-insensitive prefix/contains) and phone (prefix). Returns max 10 rows.
// Public route, rate-limited by the parent mount in index.js.
// ---------------------------------------------------------------------------

const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabase');

const MIN_QUERY_LENGTH = 2;
const MAX_RESULTS = 10;

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
