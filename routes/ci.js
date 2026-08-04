const express = require('express')
const router = express.Router()
const { supabase } = require('../services/supabase')
const { verifyToken, requireRole } = require('../middleware/auth')
const { validateCiRepaymentFields, toNumericOrNull, toIntArrayOrNull, sanitizeCiFormNumerics, computeCompositeScore } = require('../services/loanCalc')

// prior_decline_flag / application_category / finscore_attributed are here so a
// CI officer can see WHY an applicant is back: a returning applicant with a
// prior decline needs different questions than a clean renewal, and an
// attributed score means the FinScore on screen was inherited, not measured
// today. The flag was written on /submit since 2026-06 but was invisible to CI.
const CI_FIELDS = 'id, reference_id, phone, full_name, loan_type, loan_amount, loan_term, submitted_at, ci_score, interviewer, stage, application_category, linked_borrower_id, prior_decline_flag, prior_decline_reference, finscore_attributed, attributed_final_score'

router.use(verifyToken, requireRole('ci_officer', 'admin', 'super_admin', 'approver'))

// List pending applications for CI agents
router.get('/applications', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('applications')
      .select(CI_FIELDS)
      .eq('status', 'pending')
      .order('submitted_at', { ascending: true })

    if (error) throw error
    return res.json(data)
  } catch (error) {
    console.error('CI list error:', error.message)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

// Get pending application by phone — includes form_data for CI form pre-fill
router.get('/applications/phone/:phone', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('applications')
      .select(`${CI_FIELDS}, form_data`)
      .eq('phone', req.params.phone)
      .eq('status', 'pending')
      .order('submitted_at', { ascending: true })

    if (error) throw error
    return res.json(data)
  } catch (error) {
    console.error('CI phone lookup error:', error.message)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

// Submit CI score
router.patch('/applications/:id/ci-score', async (req, res) => {
  try {
    const {
      ci_score, notes, reviewed_by,
      ci_form_data, interviewer, ci_recommendation,
      ci_remarks, ci_recommended_amount, recommended_amount,
      payment_frequency, salary_payout_dates, repayment_cycle, honorarium_date
    } = req.body

    // Fetch loan_type (authoritative) up front — needed to enforce the SBL-only
    // honorarium_date requirement, alongside finscore_normalized and
    // application_category (renewals skip the bonus) for scoring.
    const { data: app, error: fetchError } = await supabase
      .from('applications')
      .select('finscore_normalized, loan_type, application_category')
      .eq('id', req.params.id)
      .single()

    if (fetchError) throw fetchError

    // Validate repayment scheduling fields (CI stage).
    const repaymentCheck = validateCiRepaymentFields({ payment_frequency, salary_payout_dates, repayment_cycle, honorarium_date, loan_type: app.loan_type })
    if (!repaymentCheck.valid) {
      return res.status(400).json({ error: repaymentCheck.errors.join('; ') })
    }

    // Bound ci_score (M4) — see admin.js ci-score route.
    const ci_score_num = Number(ci_score)
    if (!Number.isFinite(ci_score_num) || ci_score_num < 0 || ci_score_num > 50) {
      return res.status(400).json({ error: 'ci_score must be a number between 0 and 50' })
    }

    // Coerce every client-supplied numeric-bound field so "" (or any non-numeric
    // string) becomes NULL instead of hitting a numeric/integer column and
    // throwing a 500. The recommended amount arrives under any of three keys
    // (top-level ci_recommended_amount / recommended_amount, or nested in
    // ci_form_data) — take the first that resolves to a real number.
    const recommendedAmount =
      toNumericOrNull(ci_recommended_amount) ??
      toNumericOrNull(recommended_amount) ??
      toNumericOrNull(ci_form_data?.recommended_amount)
    const honorariumDate = toNumericOrNull(honorarium_date)
    const salaryPayoutDates = toIntArrayOrNull(salary_payout_dates)
    const ciFormData = sanitizeCiFormNumerics(ci_form_data)

    // An "approved" recommendation must carry a valid amount — reject with 400
    // rather than letting a missing/blank value fail deeper as a 500.
    if (ci_recommendation === 'approved' && recommendedAmount == null) {
      return res.status(400).json({ error: 'recommended_amount is required and must be a number when ci_recommendation is "approved"' })
    }

    // Composite score + tier — shared with routes/admin.js. See loanCalc.
    const isReapplication = ci_form_data?.is_reapplication === true || ci_form_data?.is_reapplication === 'true'
    const { ciNormalized: ci_normalized, finalScore: final_score, tier } = computeCompositeScore({
      finscoreNormalized: app.finscore_normalized,
      ciScore: ci_score_num,
      isReapplication,
      isRenewal: app.application_category === 'renewal'
    })

    const { error: updateError } = await supabase
      .from('applications')
      .update({
        ci_score: ci_score_num,
        ci_normalized,
        final_score,
        tier,
        notes,
        reviewed_by,
        ci_form_data: ciFormData,
        interviewer,
        ci_recommendation,
        ci_remarks,
        ci_recommended_amount: recommendedAmount,
        payment_frequency,
        salary_payout_dates: salaryPayoutDates,
        repayment_cycle,
        honorarium_date: honorariumDate,
        reviewed_at: new Date().toISOString()
      })
      .eq('id', req.params.id)

    if (updateError) throw updateError

    // Auto-transition from ci_officer to approver
    try {
      const { transitionStage } = require('../services/pipeline')
      await transitionStage(req.params.id, 'approver', req.user, {})
    } catch (transErr) {
      console.error('[ci] Auto-transition to approver failed:', transErr.message)
      // Non-fatal — CI score is already saved
    }

    // Return limited fields only
    const { data, error } = await supabase
      .from('applications')
      .select(`${CI_FIELDS}, ci_normalized, final_score, tier, ci_recommendation, ci_remarks, ci_recommended_amount`)
      .eq('id', req.params.id)
      .single()

    if (error) throw error
    return res.json(data)
  } catch (error) {
    console.error('CI score error:', error.message)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router
