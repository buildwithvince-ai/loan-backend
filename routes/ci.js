const express = require('express')
const router = express.Router()
const { supabase } = require('../services/supabase')
const { verifyToken, requireRole } = require('../middleware/auth')
const { validateCiRepaymentFields } = require('../services/loanCalc')

const CI_FIELDS = 'id, reference_id, phone, full_name, loan_type, loan_amount, loan_term, submitted_at, ci_score, interviewer, stage'

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
    return res.status(500).json({ error: error.message })
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
    return res.status(500).json({ error: error.message })
  }
})

// Submit CI score
router.patch('/applications/:id/ci-score', async (req, res) => {
  try {
    const {
      ci_score, notes, reviewed_by,
      ci_form_data, interviewer, ci_recommendation,
      ci_remarks, ci_recommended_amount,
      payment_frequency, salary_payout_dates, repayment_cycle
    } = req.body

    // Validate repayment scheduling fields (CI stage).
    const repaymentCheck = validateCiRepaymentFields({ payment_frequency, salary_payout_dates, repayment_cycle })
    if (!repaymentCheck.valid) {
      return res.status(400).json({ error: repaymentCheck.errors.join('; ') })
    }

    const { data: app, error: fetchError } = await supabase
      .from('applications')
      .select('finscore_normalized')
      .eq('id', req.params.id)
      .single()

    if (fetchError) throw fetchError

    const ci_normalized = Math.round((ci_score / 50) * 100)
    const finNorm = app.finscore_normalized || 0
    const isReapplication = ci_form_data?.is_reapplication === true || ci_form_data?.is_reapplication === 'true'
    const reapplication_bonus = isReapplication ? 10 : 0
    const raw_score = Math.round(
      ((finNorm * 0.50) + (ci_normalized * 0.50)) * 10
    ) / 10
    const final_score = Math.min(raw_score + reapplication_bonus, 100)

    let tier
    if (final_score >= 85) tier = 'approved'
    else if (final_score >= 70) tier = 'tier_b'
    else tier = 'declined'

    const { error: updateError } = await supabase
      .from('applications')
      .update({
        ci_score,
        ci_normalized,
        final_score,
        tier,
        notes,
        reviewed_by,
        ci_form_data,
        interviewer,
        ci_recommendation,
        ci_remarks,
        ci_recommended_amount,
        payment_frequency,
        salary_payout_dates,
        repayment_cycle,
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
    return res.status(500).json({ error: error.message })
  }
})

module.exports = router
