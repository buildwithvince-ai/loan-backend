const express = require('express')
const router = express.Router()
const { supabase } = require('../services/supabase')

const CI_FIELDS = 'id, reference_id, phone, full_name, loan_type, loan_amount, loan_term, submitted_at, ci_score, interviewer'

const ciAuth = (req, res, next) => {
  const secret = req.headers['x-ci-secret']
  if (secret !== process.env.CI_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  next()
}

router.use(ciAuth)

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
      ci_remarks, ci_recommended_amount
    } = req.body

    const { data: app, error: fetchError } = await supabase
      .from('applications')
      .select('finscore_normalized')
      .eq('id', req.params.id)
      .single()

    if (fetchError) throw fetchError

    const ci_normalized = Math.round((ci_score / 50) * 100)
    const final_score = Math.round(
      ((app.finscore_normalized * 0.50) + (ci_normalized * 0.50)) * 10
    ) / 10

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
        reviewed_at: new Date().toISOString()
      })
      .eq('id', req.params.id)

    if (updateError) throw updateError

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
