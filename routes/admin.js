const express = require('express')
const router = express.Router()
const { supabase } = require('../services/supabase')
const { verifyToken, requireRole } = require('../middleware/auth')

router.use(verifyToken)

// List all applications (all authenticated users)
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

// Get single application by ID
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

// Get application by phone number
router.get('/applications/phone/:phone', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('applications')
      .select('*')
      .eq('phone', req.params.phone)
      .order('submitted_at', { ascending: false })

    if (error) throw error
    return res.json(data)
  } catch (error) {
    console.error('Admin phone lookup error:', error.message)
    return res.status(500).json({ error: error.message })
  }
})

// Submit CI score and calculate final score + tier
router.patch('/applications/:id/ci-score', requireRole('admin', 'super_admin', 'ci_officer'), async (req, res) => {
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

    // Normalize CI from 0-50 scale to 0-100
    const ci_normalized = Math.round((ci_score / 50) * 100)
    const finNorm = app.finscore_normalized || 0
    const isReapplication = ci_form_data?.is_reapplication === true
    const reapplication_bonus = isReapplication ? 10 : 0
    const raw_score = Math.round(
      ((finNorm * 0.50) + (ci_normalized * 0.50)) * 10
    ) / 10
    const final_score = Math.min(raw_score + reapplication_bonus, 100)

    let tier
    if (final_score >= 85) tier = 'approved'
    else if (final_score >= 70) tier = 'tier_b'
    else tier = 'declined'

    const { data, error } = await supabase
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
      .select()
      .single()

    if (error) throw error

    // Auto-transition from ci_officer to approver
    try {
      const { transitionStage } = require('../services/pipeline')
      await transitionStage(req.params.id, 'approver', req.user, {})
    } catch (transErr) {
      console.error('[admin] Auto-transition to approver failed:', transErr.message)
      // Non-fatal — CI score is already saved
    }

    return res.json(data)
  } catch (error) {
    console.error('CI score error:', error.message)
    return res.status(500).json({ error: error.message })
  }
})

// Approve application — DEPRECATED: use PATCH /api/pipeline/:id/transition { to_stage: 'loan_processing_officer' }
// Kept as a convenience wrapper that delegates to the pipeline transition.
router.patch('/applications/:id/approve', requireRole('admin', 'super_admin'), async (req, res) => {
  try {
    const { transitionStage } = require('../services/pipeline')
    const updated = await transitionStage(req.params.id, 'loan_processing_officer', req.user, {})
    return res.json({ status: 'approved', borrowerId: updated.loandisk_borrower_id })
  } catch (error) {
    console.error('Approve error:', error.message)
    return res.status(400).json({ error: error.message })
  }
})

// Export consent report as CSV
router.get('/export/consent', requireRole('admin', 'super_admin'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('applications')
      .select('reference_id, full_name, phone, loan_type, consent_agreed, consent_agreed_at, submitted_at')
      .eq('consent_agreed', true)
      .order('submitted_at', { ascending: false })

    if (error) throw error

    const formatPH = (iso) => {
      if (!iso) return ''
      return new Date(iso).toLocaleString('en-PH', {
        timeZone: 'Asia/Manila',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false
      }).replace(/(\d+)\/(\d+)\/(\d+),?\s*/, '$3-$1-$2 ')
    }

    const escape = (val) => {
      const str = String(val ?? '')
      return str.includes(',') || str.includes('"') || str.includes('\n')
        ? '"' + str.replace(/"/g, '""') + '"'
        : str
    }

    const header = 'Reference ID,Full Name,Phone Number,Loan Type,Consent Agreed,Consent Date,Submitted At'
    const rows = data.map(r => [
      r.reference_id,
      escape(r.full_name),
      r.phone,
      r.loan_type,
      r.consent_agreed ? 'Yes' : 'No',
      formatPH(r.consent_agreed_at),
      formatPH(r.submitted_at)
    ].join(','))

    const csv = [header, ...rows].join('\n')

    res.setHeader('Content-Type', 'text/csv')
    res.setHeader('Content-Disposition', 'attachment; filename="consent_report.csv"')
    return res.send(csv)
  } catch (error) {
    console.error('Consent export error:', error.message)
    return res.status(500).json({ error: error.message })
  }
})

// Decline application — DEPRECATED: use PATCH /api/pipeline/:id/transition { to_stage: 'declined', meta: { decline_reason } }
// Kept as a convenience wrapper that delegates to the pipeline transition.
router.patch('/applications/:id/decline', requireRole('admin', 'super_admin'), async (req, res) => {
  try {
    const { transitionStage } = require('../services/pipeline')
    const { notes } = req.body
    const updated = await transitionStage(req.params.id, 'declined', req.user, { decline_reason: notes })
    return res.json({ status: 'declined' })
  } catch (error) {
    console.error('Decline error:', error.message)
    return res.status(400).json({ error: error.message })
  }
})

module.exports = router
