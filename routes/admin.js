const express = require('express')
const router = express.Router()
const { supabase } = require('../services/supabase')
const { createBorrower, uploadAllFiles } = require('../services/loandisk')

const adminAuth = (req, res, next) => {
  const secret = req.headers['x-admin-secret']
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  next()
}

router.use(adminAuth)

// List all applications
router.get('/applications', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('applications')
      .select('*')
      .order('submitted_at', { ascending: false })

    if (error) throw error
    return res.json(data)
  } catch (error) {
    console.error('Admin list error:', error.message)
    return res.status(500).json({ error: error.message })
  }
})

// Get single application
router.get('/applications/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('applications')
      .select('*')
      .eq('id', req.params.id)
      .single()

    if (error) throw error
    return res.json(data)
  } catch (error) {
    console.error('Admin get error:', error.message)
    return res.status(500).json({ error: error.message })
  }
})

// Submit CI score and calculate final score + tier
router.patch('/applications/:id/ci-score', async (req, res) => {
  try {
    const { ci_score, notes, reviewed_by } = req.body

    // Get current application for finscore_normalized
    const { data: app, error: fetchError } = await supabase
      .from('applications')
      .select('finscore_normalized')
      .eq('id', req.params.id)
      .single()

    if (fetchError) throw fetchError

    const final_score = Math.round(
      (app.finscore_normalized * 0.50) + (ci_score * 0.50)
    )

    let tier
    if (final_score >= 85) tier = 'approved'
    else if (final_score >= 70) tier = 'tier_b'
    else tier = 'declined'

    const { data, error } = await supabase
      .from('applications')
      .update({
        ci_score,
        final_score,
        tier,
        notes,
        reviewed_by,
        reviewed_at: new Date().toISOString()
      })
      .eq('id', req.params.id)
      .select()
      .single()

    if (error) throw error
    return res.json(data)
  } catch (error) {
    console.error('CI score error:', error.message)
    return res.status(500).json({ error: error.message })
  }
})

// Approve application — push to Loandisk
router.patch('/applications/:id/approve', async (req, res) => {
  try {
    const { reviewed_by, adjusted_amount, adjusted_term } = req.body

    const { data: app, error: fetchError } = await supabase
      .from('applications')
      .select('*')
      .eq('id', req.params.id)
      .single()

    if (fetchError) throw fetchError

    if (app.tier === 'declined') {
      return res.status(400).json({ error: 'Cannot approve a declined-tier application' })
    }

    const formData = app.form_data
    if (adjusted_amount) formData.loanAmount = adjusted_amount
    if (adjusted_term) formData.loanTerm = adjusted_term

    const finScore = {
      score: app.finscore_raw,
      riskBand: 'N/A',
      fraudFlag: 'false'
    }

    const borrowerId = await createBorrower(formData, finScore)

    const { data, error } = await supabase
      .from('applications')
      .update({
        status: 'approved',
        loandisk_borrower_id: borrowerId,
        reviewed_by,
        reviewed_at: new Date().toISOString()
      })
      .eq('id', req.params.id)
      .select()
      .single()

    if (error) throw error
    return res.json({ status: 'approved', borrowerId })
  } catch (error) {
    console.error('Approve error:', error.message)
    return res.status(500).json({ error: error.message })
  }
})

// Decline application
router.patch('/applications/:id/decline', async (req, res) => {
  try {
    const { reviewed_by, notes } = req.body

    const { data, error } = await supabase
      .from('applications')
      .update({
        status: 'declined',
        reviewed_by,
        notes,
        reviewed_at: new Date().toISOString()
      })
      .eq('id', req.params.id)
      .select()
      .single()

    if (error) throw error
    return res.json({ status: 'declined' })
  } catch (error) {
    console.error('Decline error:', error.message)
    return res.status(500).json({ error: error.message })
  }
})

module.exports = router
