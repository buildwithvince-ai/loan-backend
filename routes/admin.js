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

    // Normalize CI from 0-50 scale to 0-100
    const ci_normalized = Math.round((ci_score / 50) * 100)
    const final_score = Math.round(
      ((app.finscore_normalized * 0.50) + (ci_normalized * 0.50)) * 10
    ) / 10

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

    if (app.ci_score === null || app.ci_score === undefined) {
      return res.status(400).json({ error: 'CI form must be completed before approval' })
    }
    if (!app.tier) {
      return res.status(400).json({ error: 'Tier must be calculated before approval' })
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

    // Pull files from Supabase Storage and upload to Loandisk
    const fileMetadata = app.file_metadata || []
    if (fileMetadata.length > 0) {
      const filesToUpload = []

      for (const fileMeta of fileMetadata) {
        const { data: fileData, error: downloadError } = await supabase.storage
          .from('application-files')
          .download(fileMeta.storage_path)

        if (downloadError) {
          console.error(`Failed to download ${fileMeta.original_name}:`, downloadError.message)
          continue
        }

        const buffer = Buffer.from(await fileData.arrayBuffer())
        filesToUpload.push({
          originalname: fileMeta.original_name,
          buffer
        })
      }

      if (filesToUpload.length > 0) {
        await uploadAllFiles(borrowerId, filesToUpload)
        console.log(`Uploaded ${filesToUpload.length} files to Loandisk for borrower ${borrowerId}`)
      }
    }

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

// Export consent report as CSV
router.get('/export/consent', async (req, res) => {
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

// Decline application
router.patch('/applications/:id/decline', async (req, res) => {
  try {
    const { reviewed_by, notes } = req.body

    const { data: app, error: fetchError } = await supabase
      .from('applications')
      .select('ci_score')
      .eq('id', req.params.id)
      .single()

    if (fetchError) throw fetchError

    if (app.ci_score === null || app.ci_score === undefined) {
      return res.status(400).json({ error: 'CI form must be completed before declining' })
    }

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
