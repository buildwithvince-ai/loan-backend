const { supabase } = require('./supabase');

// Every application belonging to one Loandisk borrower, newest first.
//
// A client's history has two sides: rows that own the id (loandisk_borrower_id,
// written on first approval) and renewals pointing at it (linked_borrower_id,
// written on submit). Both must match or a renewal disappears from its own
// client's history.
//
// Shared by the admin and CI history routes so the two panels cannot drift on
// what "this client's history" means. Callers pass their own field projection —
// admin sends LIST_FIELDS, CI sends the narrower CI_FIELDS.
//
// Returns null when the id is empty after sanitising, so callers can 400
// rather than run an unbounded query.
async function fetchBorrowerHistory(borrowerId, fields) {
  // Strip PostgREST or() metacharacters before interpolating — same guard as
  // routes/borrowers.js. An unescaped comma or paren rewrites the filter.
  const safeId = String(borrowerId || '').trim().replace(/[,()*]/g, '');
  if (!safeId) return null;

  const { data, error } = await supabase
    .from('applications')
    .select(fields)
    .or(`loandisk_borrower_id.eq.${safeId},linked_borrower_id.eq.${safeId}`)
    .order('submitted_at', { ascending: false });

  if (error) throw error;
  return data;
}

module.exports = { fetchBorrowerHistory };
