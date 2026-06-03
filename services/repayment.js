'use strict';

// ---------------------------------------------------------------------------
// First repayment date calculation — per-product rules.
// Confirmed by ops 2026-06-03 (docs/Loan-Products-first-payment-sched.md):
//
//   AKAP     : release + 7 days, then weekly. No salary date.
//   SME      : release + 1 month, same day-of-month. EOM-snapped. No salary date.
//   SBL      : release + 15 days, then the next honorarium date (caller passes
//              the honorarium day as the single salaryPayoutDates value).
//   Personal : release + 15 days, then the next salary date.
//   Group    : release + 15 days, then the next salary date.
//
// EOM rule (all products): snap a day to the last valid day of its month via
// Math.min(day, lastDayOfMonth) — e.g. day 31 in Feb = 28 (29 in a leap year).
//
// All date math uses UTC parts so results are timezone-deterministic (Railway
// runs UTC; this stays correct off-UTC too).
// ---------------------------------------------------------------------------

const { normalizeLoanType } = require('../config/loanProducts');

// Parse a Date | 'YYYY-MM-DD' into UTC [year, month(0-based), day].
function toUtcParts(loanReleaseDate) {
  if (loanReleaseDate instanceof Date) {
    if (Number.isNaN(loanReleaseDate.getTime())) {
      throw new Error('calculateFirstRepaymentDate: invalid loanReleaseDate');
    }
    return [loanReleaseDate.getUTCFullYear(), loanReleaseDate.getUTCMonth(), loanReleaseDate.getUTCDate()];
  }
  const parts = String(loanReleaseDate || '').slice(0, 10).split('-').map(Number);
  if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`calculateFirstRepaymentDate: invalid loanReleaseDate "${loanReleaseDate}"`);
  }
  return [parts[0], parts[1] - 1, parts[2]];
}

function toIso(dateUtc) {
  return dateUtc.toISOString().slice(0, 10);
}

// Resolve the payout days for the salary-snap products. Prefers an explicit
// salaryPayoutDates array; falls back to parsing the repaymentCycle string
// (e.g. '15-30' -> [15, 30]) so a stored cycle alone still works.
function resolvePayoutDates(repaymentCycle, salaryPayoutDates) {
  let days = Array.isArray(salaryPayoutDates) ? salaryPayoutDates.map(Number) : [];
  if (days.length === 0 && repaymentCycle != null) {
    days = String(repaymentCycle).split('-').map((x) => parseInt(x, 10));
  }
  return days.filter((n) => Number.isFinite(n) && n >= 1 && n <= 31).sort((a, b) => a - b);
}

// calculateFirstRepaymentDate
//   loanReleaseDate   : Date | 'YYYY-MM-DD'
//   loanType          : 'akap' | 'sme' | 'sbl' | 'personal' | 'group' (case-insensitive)
//   repaymentCycle    : cycle string e.g. '15' or '15-30' (fallback payout source)
//   salaryPayoutDates : array of day-of-month ints (1-31). For SBL the caller
//                       passes [honorariumDate].
// Returns the first repayment date as ISO 'YYYY-MM-DD'.
function calculateFirstRepaymentDate(loanReleaseDate, loanType, repaymentCycle, salaryPayoutDates) {
  const [y, m, d] = toUtcParts(loanReleaseDate);
  const type = normalizeLoanType(loanType);

  // AKAP: release + 7 days, weekly. No salary date.
  if (type === 'akap') {
    return toIso(new Date(Date.UTC(y, m, d + 7)));
  }

  // SME: release + 1 month, same day-of-month, EOM-snapped. No salary date.
  if (type === 'sme') {
    const lastDayNextMonth = new Date(Date.UTC(y, m + 2, 0)).getUTCDate();
    const day = Math.min(d, lastDayNextMonth);
    return toIso(new Date(Date.UTC(y, m + 1, day)));
  }

  // Personal / Group / SBL: release + 15 days, then the next payout/honorarium date.
  const payoutDates = resolvePayoutDates(repaymentCycle, salaryPayoutDates);
  if (payoutDates.length === 0) {
    throw new Error(`calculateFirstRepaymentDate: no salary/honorarium payout dates for ${type || 'loan'}`);
  }

  const threshold = new Date(Date.UTC(y, m, d + 15)); // release + 15 days

  let cy = y;
  let cm = m;
  for (let i = 0; i < 24; i += 1) {
    const lastDayOfMonth = new Date(Date.UTC(cy, cm + 1, 0)).getUTCDate();
    for (const payoutDate of payoutDates) {
      const snapped = Math.min(payoutDate, lastDayOfMonth);
      const candidate = new Date(Date.UTC(cy, cm, snapped));
      if (candidate.getTime() > threshold.getTime()) {
        return toIso(candidate);
      }
    }
    cm += 1;
    if (cm > 11) { cm = 0; cy += 1; }
  }

  throw new Error('calculateFirstRepaymentDate: no valid repayment date found within 24 months');
}

module.exports = { calculateFirstRepaymentDate };
