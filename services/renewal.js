'use strict';

// Pure, side-effect-free renewal eligibility. Unit-testable — the caller does
// the Supabase reads and hands the rows in.
//
// Why this exists: `application_category` and `linked_borrower_id` arrive in
// the /submit payload from the frontend renewal picker. Those values are
// applicant-controlled and are NOT the source of truth. Every submission is
// resolved against the applicant's own prior applications, matched on phone.
//
// Two outcomes, deliberately decoupled — a returning borrower is not
// automatically a borrower whose score can be reused:
//
//   1. Borrower reuse (isRenewal) — any prior application with
//      status = 'approved' and a loandisk_borrower_id. Lets the approval path
//      attach to the existing Loandisk borrower instead of creating a duplicate
//      (DECISIONS.md 013). No time limit: a borrower from three years ago is
//      still the same borrower.
//
//   2. FinScore fast-path (canSkipFinScore) — borrower reuse PLUS a prior
//      FinScore no older than RENEWAL_SCORE_MAX_AGE_DAYS and actually usable.
//      Skips the FinScore call entirely and inherits the score components.
//
// A prior decline never earns either outcome on its own. A decline that
// postdates the approval invalidates the fast-path (see below) but leaves
// borrower reuse intact.

// Confirmed with the operator 2026-08-04: 90 days, measured from the source
// row's submitted_at. There is no separate FinScore timestamp column —
// finscore_raw is stamped during /submit, so submitted_at IS when the score
// was measured. reviewed_at would read newer than the score actually is.
const RENEWAL_SCORE_MAX_AGE_DAYS = 90;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Reasons the fast-path was refused while borrower reuse still applied. Written
// to the logs so ops can tell "no prior borrower" from "score too old".
const INELIGIBLE_SCORE_STALE = 'score_outside_recency_window';
const INELIGIBLE_SCORE_UNUSABLE = 'prior_finscore_unusable';
const INELIGIBLE_LATER_DECLINE = 'decline_postdates_approval';
const INELIGIBLE_BAD_TIMESTAMP = 'prior_submitted_at_unreadable';

const NO_RENEWAL = Object.freeze({
  isRenewal: false,
  canSkipFinScore: false,
  linkedBorrowerId: null,
  sourceApplicationId: null,
  attributedFinscoreRaw: null,
  attributedFinscoreNormalized: null,
  attributedFinalScore: null,
  sourceSubmittedAt: null,
  sourceReferenceId: null,
  ineligibleReason: null,
});

/**
 * Decide how a submission relates to the applicant's history.
 *
 * @param {object|null} priorApproved Most recent application for this phone with
 *   status='approved' and a non-null loandisk_borrower_id. Needs the columns
 *   id, loandisk_borrower_id, finscore_raw, finscore_normalized, final_score,
 *   submitted_at, reference_id.
 * @param {object|null} latestDecline Most recent application for this phone with
 *   status='declined'. Needs submitted_at. Pass null when there is none.
 * @param {number} nowMs Current time in epoch ms.
 * @returns {{isRenewal: boolean, canSkipFinScore: boolean, linkedBorrowerId: string|null,
 *   sourceApplicationId: string|null, attributedFinscoreRaw: number|null,
 *   attributedFinscoreNormalized: number|null, attributedFinalScore: number|null,
 *   sourceSubmittedAt: string|null, sourceReferenceId: string|null,
 *   ineligibleReason: string|null}}
 */
function evaluateRenewal(priorApproved, latestDecline, nowMs) {
  if (!priorApproved || !priorApproved.loandisk_borrower_id) {
    return { ...NO_RENEWAL };
  }

  // Borrower reuse is settled at this point; everything below only decides
  // whether the score comes with it.
  const linked = {
    ...NO_RENEWAL,
    isRenewal: true,
    linkedBorrowerId: priorApproved.loandisk_borrower_id,
    sourceApplicationId: priorApproved.id,
  };

  const approvedMs = Date.parse(priorApproved.submitted_at);
  if (!Number.isFinite(approvedMs)) {
    return { ...linked, ineligibleReason: INELIGIBLE_BAD_TIMESTAMP };
  }

  // A decline recorded AFTER the approval we would inherit from means something
  // went wrong since that good outcome — re-measure rather than carry the old
  // score forward. An older decline is already accounted for by the approval
  // that followed it.
  const declineMs = latestDecline ? Date.parse(latestDecline.submitted_at) : NaN;
  if (Number.isFinite(declineMs) && declineMs > approvedMs) {
    return { ...linked, ineligibleReason: INELIGIBLE_LATER_DECLINE };
  }

  const ageDays = (nowMs - approvedMs) / MS_PER_DAY;
  if (ageDays > RENEWAL_SCORE_MAX_AGE_DAYS) {
    return { ...linked, ineligibleReason: INELIGIBLE_SCORE_STALE };
  }

  // Manual-override approvals (migration 010) carry no FinScore at all, and a
  // noScore FinScore response persists as 0. Neither can be attributed — a 0
  // normalized score would silently halve the composite.
  const raw = Number(priorApproved.finscore_raw);
  const normalized = Number(priorApproved.finscore_normalized);
  if (!Number.isFinite(raw) || raw <= 0 || !Number.isFinite(normalized) || normalized <= 0) {
    return { ...linked, ineligibleReason: INELIGIBLE_SCORE_UNUSABLE };
  }

  const priorFinal = Number(priorApproved.final_score);

  // Provenance travels with the attributed score. The copied finscore_raw /
  // finscore_normalized are byte-identical to a freshly measured score, so
  // without these the approver sees a possibly-89-day-old number with nothing
  // on the number itself saying so. Set only on the fast-path — a renewal that
  // re-ran FinScore measured its own score and has no provenance to carry.
  return {
    ...linked,
    canSkipFinScore: true,
    attributedFinscoreRaw: raw,
    attributedFinscoreNormalized: normalized,
    attributedFinalScore: Number.isFinite(priorFinal) ? priorFinal : null,
    sourceSubmittedAt: priorApproved.submitted_at,
    sourceReferenceId: priorApproved.reference_id || null,
  };
}

module.exports = {
  evaluateRenewal,
  RENEWAL_SCORE_MAX_AGE_DAYS,
};
