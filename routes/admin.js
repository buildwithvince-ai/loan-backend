const express = require('express')
const router = express.Router()
const { supabase } = require('../services/supabase')
const { verifyAdminSecretOrToken, requireRole } = require('../middleware/auth')
const { validateCiRepaymentFields } = require('../services/loanCalc')

router.use(verifyAdminSecretOrToken)

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

// Get signed file URLs for an application — must be before /:id to avoid route capture
router.get('/applications/:id/files', async (req, res) => {
  // Signed URLs expire in 1h — must not be cached by CDN / browser / edge.
  // Cache-Control covers browsers. Surrogate-Control specifically tells Fastly
  // (Railway's edge) not to cache even if Cache-Control is stripped downstream.
  // Disabling app-level ETag matching for this response also prevents Express
  // from returning 304 on conditional GETs, which would let the browser reuse
  // a cached body containing now-expired signed URLs.
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
  res.set('Pragma', 'no-cache')
  res.set('Surrogate-Control', 'no-store')
  res.set('Vary', '*')

  try {
    const { data: app, error } = await supabase
      .from('applications')
      .select('file_metadata, reference_id, full_name')
      .eq('id', req.params.id)
      .single()

    if (error || !app) {
      return res.status(404).json({ error: 'Application not found' })
    }

    const files = app.file_metadata || []
    if (files.length === 0) return res.json([])

    // Candidate folders — legacy storage paths used 3 patterns over time:
    //   1. `${reference_id}/${originalname}`                            (oldest)
    //   2. `${reference_id}_${first}-${last}/${originalname}`           (middle)
    //   3. `${reference_id}_${first}-${last}/${fieldname}_${origname}`  (current)
    // We list each candidate folder once, then match each metadata entry.
    const candidateFolders = []
    if (app.reference_id && app.full_name) {
      const parts = app.full_name.trim().split(/\s+/)
      const first = parts[0] || ''
      const last = parts.slice(1).join('-') || ''
      candidateFolders.push(`${app.reference_id}_${first}-${last}`)
    }
    if (app.reference_id) candidateFolders.push(app.reference_id)

    // Always list candidate folders — even when metadata has storage_path.
    // A cached/stale storage_path can point at a file that's been moved
    // (case, spacing, rename drift). Listing is the source of truth.
    const folderIndex = {}
    await Promise.all(candidateFolders.map(async (folder) => {
      const { data, error: listErr } = await supabase.storage
        .from('application-files')
        .list(folder, { limit: 1000 })
      if (listErr) {
        console.error('[admin/files] list error', { folder, error: listErr.message, status: listErr.statusCode || listErr.status })
        return
      }
      folderIndex[folder] = new Set((data || []).map(x => x.name))
    }))

    const totalListedFiles = Object.values(folderIndex).reduce((n, s) => n + s.size, 0)
    console.log('[admin/files] folder listing', {
      app_id: req.params.id,
      candidateFolders,
      listedCounts: Object.fromEntries(Object.entries(folderIndex).map(([k, v]) => [k, v.size])),
      totalListedFiles,
    })

    const pickByListing = (file) => {
      const name = file.original_name
      const field = file.field_name
      for (const folder of candidateFolders) {
        const names = folderIndex[folder]
        if (!names) continue
        if (field && name && names.has(`${field}_${name}`)) return { path: `${folder}/${field}_${name}`, source: 'list_with_prefix' }
        if (name && names.has(name)) return { path: `${folder}/${name}`, source: 'list_no_prefix' }
      }
      return null
    }

    const trySign = async (path) => {
      const { data, error: signError } = await supabase.storage
        .from('application-files')
        .createSignedUrl(path, 3600)
      if (signError) return { signError }
      if (!data?.signedUrl) return { empty: true }
      return { url: data.signedUrl }
    }

    const signed = await Promise.all(
      files.map(async (file) => {
        // Attempt 1 — listing-resolved path (authoritative)
        const listed = pickByListing(file)
        if (listed) {
          const { url, signError } = await trySign(listed.path)
          if (url) return { field: file.field_name || null, name: file.original_name, url }
          if (signError) {
            console.error('[admin/files] signedUrl error (listed path)', {
              app_id: req.params.id, path: listed.path, source: listed.source,
              error: signError.message, status: signError.statusCode || signError.status,
            })
          }
        }

        // Attempt 2 — fall back to metadata-stored path
        if (file.storage_path) {
          const { url, signError } = await trySign(file.storage_path)
          if (url) return { field: file.field_name || null, name: file.original_name, url }
          if (signError) {
            console.error('[admin/files] signedUrl error (metadata path)', {
              app_id: req.params.id, path: file.storage_path, source: 'metadata',
              error: signError.message, status: signError.statusCode || signError.status,
              note: 'check SUPABASE_SERVICE_KEY on Railway and bucket RLS policies',
            })
          }
        }

        return {
          field: file.field_name || null,
          name: file.original_name,
          url: null,
          debug: listed ? `sign_error_all_attempts:${listed.path}` : 'no_matching_file_in_bucket',
        }
      })
    )

    return res.json(signed)
  } catch (error) {
    console.error('[admin/files] unexpected error:', error.message, error.stack)
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
router.patch('/applications/:id/ci-score', requireRole('admin', 'super_admin', 'ci_officer', 'approver'), async (req, res) => {
  try {
    const {
      ci_score, notes, reviewed_by,
      ci_form_data, interviewer, ci_recommendation,
      ci_remarks, ci_recommended_amount,
      payment_frequency, salary_payout_dates, repayment_cycle, honorarium_date
    } = req.body

    // Fetch loan_type (authoritative) up front — needed to enforce the SBL-only
    // honorarium_date requirement, alongside finscore_normalized for scoring.
    const { data: app, error: fetchError } = await supabase
      .from('applications')
      .select('finscore_normalized, loan_type')
      .eq('id', req.params.id)
      .single()

    if (fetchError) throw fetchError

    // Validate repayment scheduling fields (CI stage).
    const repaymentCheck = validateCiRepaymentFields({ payment_frequency, salary_payout_dates, repayment_cycle, honorarium_date, loan_type: app.loan_type })
    if (!repaymentCheck.valid) {
      return res.status(400).json({ error: repaymentCheck.errors.join('; ') })
    }

    // Normalize CI from 0-50 scale to 0-100
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
        payment_frequency,
        salary_payout_dates,
        repayment_cycle,
        honorarium_date,
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

// Manual override for no-FinScore declines.
// Restricted to approver/admin/super_admin. Pushes an application that has no
// usable FinScore back into the approver stage so a human can decide it.
// Guardrail: this is NOT a low-score escape hatch — if a valid FinScore is
// present, the request is rejected. Override only applies when finscore_raw
// is null or 0.
router.patch('/applications/:id/override', requireRole('admin', 'super_admin', 'approver'), async (req, res) => {
  try {
    const { override_reason } = req.body

    if (!override_reason || !String(override_reason).trim()) {
      return res.status(400).json({ error: 'override_reason is required' })
    }

    if (String(override_reason).trim().length < 10) {
      return res.status(400).json({ error: 'override_reason must be at least 10 characters' })
    }

    const { data: app, error: fetchError } = await supabase
      .from('applications')
      .select('finscore_raw, stage_history')
      .eq('id', req.params.id)
      .single()

    if (fetchError || !app) {
      return res.status(404).json({ error: 'Application not found' })
    }

    // Gate: override is only for a missing FinScore. A present, non-zero score
    // means the decline came from the score itself — not overridable here.
    const hasFinScore = app.finscore_raw !== null && Number(app.finscore_raw) !== 0
    if (hasFinScore) {
      return res.status(403).json({
        error: 'Override is only allowed when FinScore is missing (null or 0). This application has a valid FinScore.'
      })
    }

    const now = new Date().toISOString()
    const existingHistory = Array.isArray(app.stage_history) ? app.stage_history : []
    const historyEntry = {
      event: 'manual_override',
      to: 'approver',
      by: req.user.id,
      by_name: req.user.full_name,
      reason: override_reason,
      at: now
    }

    // overridden_by is a uuid FK to admin_users(id). The x-admin-secret auth
    // path sets req.user.id = 'admin-secret' (not a uuid), which would fail the
    // FK/type constraint. Only write it for real JWT users; stage_history still
    // records the raw actor for audit either way.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    const overriddenBy = UUID_RE.test(req.user.id) ? req.user.id : null

    const { data, error } = await supabase
      .from('applications')
      .update({
        manual_override: true,
        override_reason,
        overridden_by: overriddenBy,
        overridden_at: now,
        stage: 'approver',
        status: 'pending',
        stage_history: [...existingHistory, historyEntry]
      })
      .eq('id', req.params.id)
      .select()
      .single()

    if (error) throw error

    console.log('[admin:override] applied', { application_id: req.params.id, by: req.user.id })
    return res.json(data)
  } catch (error) {
    console.error('Override error:', error.message)
    return res.status(500).json({ error: error.message })
  }
})

// Approve application.
// Body fields forwarded to the approval guard:
//   interest_rate, payment_scheme_id, discount_reason
// Adjusted-terms loop (Issue 3):
//   adjusted_amount, adjusted_term — when either differs from the original
//   loan_amount/loan_term, status flips to `pending_sa_confirmation` and the
//   Loandisk push is deferred until the SA confirms via /confirm-terms.
router.patch('/applications/:id/approve', requireRole('admin', 'super_admin', 'approver'), async (req, res) => {
  try {
    // Supervisor-override gate for auto-declined applications.
    // An app whose scoring engine tier resolved to 'declined' (final_score < 70)
    // sits at the approver stage awaiting a human decision. Approving it is a
    // supervisor-only action requiring an explicit override flag.
    //
    // The gate keys off the persisted `tier`, NOT the presence of `override`.
    // Keying off the flag would let a caller omit it and approve the declined
    // app through the normal path — the flag would gate nothing. Runs before the
    // adjusted-terms and direct-approval branches so neither can move a declined
    // app forward unguarded. Supervisor roles = super_admin, approver (admin is
    // intentionally excluded from override; admin retains normal approve rights).
    const { data: gateRow, error: gateErr } = await supabase
      .from('applications')
      .select('tier, status')
      .eq('id', req.params.id)
      .single()
    if (gateErr || !gateRow) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Application not found' } })
    }
    if (gateRow.tier === 'declined') {
      const SUPERVISOR_ROLES = ['super_admin', 'approver']
      const userRoles = req.user?.roles || []
      const isSupervisor = SUPERVISOR_ROLES.some((r) => userRoles.includes(r))
      const overrideRequested = req.body?.override === true
      if (!overrideRequested || !isSupervisor) {
        return res.status(403).json({
          success: false,
          error: {
            code: 'OVERRIDE_FORBIDDEN',
            message: 'Approving a declined application requires a supervisor override (super_admin or approver) with override:true.'
          }
        })
      }
      // No audit table exists yet — log to console per project convention.
      console.log('[admin:override-approve] applied', {
        application_id: req.params.id,
        by: req.user?.id,
        roles: userRoles,
        prior_tier: gateRow.tier,
        prior_status: gateRow.status,
        at: new Date().toISOString()
      })
    }

    const adjustedAmount = req.body?.adjusted_amount != null ? Number(req.body.adjusted_amount) : null
    const adjustedTerm = req.body?.adjusted_term != null ? Number(req.body.adjusted_term) : null
    // loan_release_date is required to process approval (enforced at the Loandisk
    // push chokepoint in executeLoandiskApproval). Persist it on every branch so
    // it survives the adjusted-terms -> confirm-terms detour.
    const loanReleaseDate = req.body?.loan_release_date || null

    // Diff branch — fetch the row to compare against persisted values.
    if (adjustedAmount != null || adjustedTerm != null) {
      const { data: current, error: fetchErr } = await supabase
        .from('applications')
        .select('id, loan_amount, loan_term, status, stage')
        .eq('id', req.params.id)
        .single()

      if (fetchErr || !current) {
        return res.status(404).json({ error: 'Application not found' })
      }

      const origAmount = Number(current.loan_amount)
      const origTerm = Number(current.loan_term)
      const proposedAmount = adjustedAmount != null ? adjustedAmount : origAmount
      const proposedTerm = adjustedTerm != null ? adjustedTerm : origTerm

      const amountDiffs = adjustedAmount != null && adjustedAmount !== origAmount
      const termDiffs = adjustedTerm != null && adjustedTerm !== origTerm

      if (amountDiffs || termDiffs) {
        const { data: updated, error: updateErr } = await supabase
          .from('applications')
          .update({
            status: 'pending_sa_confirmation',
            approver_proposed_amount: proposedAmount,
            approver_proposed_term: proposedTerm,
            approver_proposed_at: new Date().toISOString(),
            approver_proposed_by: req.user?.id?.length === 36 ? req.user.id : null,
            sa_rejection_note: null,
            sa_rejection_at: null,
            sa_rejection_by: null,
            ...(loanReleaseDate ? { loan_release_date: loanReleaseDate } : {})
          })
          .eq('id', req.params.id)
          .select()
          .single()

        if (updateErr) throw updateErr

        return res.json({
          status: 'pending_sa_confirmation',
          approver_proposed_amount: updated.approver_proposed_amount,
          approver_proposed_term: updated.approver_proposed_term,
          message: 'Adjusted terms recorded — awaiting SA confirmation.'
        })
      }
      // No actual diff — fall through to direct approval.
    }

    // Persist the release date before the transition so the Loandisk push
    // chokepoint (executeLoandiskApproval) reads it from the row.
    if (loanReleaseDate) {
      const { error: relErr } = await supabase
        .from('applications')
        .update({ loan_release_date: loanReleaseDate })
        .eq('id', req.params.id)
      if (relErr) throw relErr
    }

    const { transitionStage } = require('../services/pipeline')
    const meta = {
      interest_rate: req.body?.interest_rate,
      payment_scheme_id: req.body?.payment_scheme_id,
      discount_reason: req.body?.discount_reason
    }
    const updated = await transitionStage(req.params.id, 'loan_processing_officer', req.user, meta)
    return res.json({
      status: 'approved',
      borrowerId: updated.loandisk_borrower_id,
      loanId: updated.loandisk_loan_id,
      fees: {
        service_fee: updated.service_fee_amount,
        insurance_fee: updated.insurance_fee_amount,
        total_fees: updated.total_fees_amount,
        net_disbursement: updated.net_disbursement_amount
      }
    })
  } catch (error) {
    console.error('Approve error:', error.message)
    return res.status(400).json({ error: error.message })
  }
})

// Confirm proposed adjusted terms — SA-only.
// Reads the persisted approver_proposed_amount/term, runs the deferred
// Loandisk push with those values, and advances the stage.
router.patch('/applications/:id/confirm-terms', requireRole('admin', 'super_admin', 'approver'), async (req, res) => {
  try {
    const { data: current, error: fetchErr } = await supabase
      .from('applications')
      .select('*')
      .eq('id', req.params.id)
      .single()

    if (fetchErr || !current) {
      return res.status(404).json({ error: 'Application not found' })
    }

    if (current.status !== 'pending_sa_confirmation') {
      return res.status(400).json({ error: 'Application is not awaiting SA confirmation' })
    }

    if (current.approver_proposed_amount == null || current.approver_proposed_term == null) {
      return res.status(400).json({ error: 'No proposed terms recorded on this application' })
    }

    const { transitionStage } = require('../services/pipeline')
    const meta = {
      principal: current.approver_proposed_amount,
      duration_months: current.approver_proposed_term,
      interest_rate: req.body?.interest_rate,
      payment_scheme_id: req.body?.payment_scheme_id,
      discount_reason: req.body?.discount_reason
    }

    // Adopt the proposed values as the official loan_amount / loan_term before
    // transitioning, so downstream reads see the confirmed numbers. Also accept
    // a loan_release_date override here (falls back to the one persisted at the
    // adjusted-terms approve step).
    const confirmReleaseDate = req.body?.loan_release_date || null
    await supabase
      .from('applications')
      .update({
        loan_amount: current.approver_proposed_amount,
        loan_term: current.approver_proposed_term,
        ...(confirmReleaseDate ? { loan_release_date: confirmReleaseDate } : {})
      })
      .eq('id', req.params.id)

    const updated = await transitionStage(req.params.id, 'loan_processing_officer', req.user, meta)
    return res.json(updated)
  } catch (error) {
    console.error('Confirm-terms error:', error.message)
    return res.status(400).json({ error: error.message })
  }
})

// Reject proposed adjusted terms — SA-only.
// Body: { note: string } (required, non-empty).
// Resets status back to `pending` with stage `approver` so the approver can
// re-review. Stores the note + timestamp + actor for the activity log.
router.patch('/applications/:id/reject-terms', requireRole('admin', 'super_admin', 'approver'), async (req, res) => {
  try {
    const note = String(req.body?.note || '').trim()
    if (!note) {
      return res.status(400).json({ error: 'note is required' })
    }

    const { data: current, error: fetchErr } = await supabase
      .from('applications')
      .select('id, status, stage_history')
      .eq('id', req.params.id)
      .single()

    if (fetchErr || !current) {
      return res.status(404).json({ error: 'Application not found' })
    }

    if (current.status !== 'pending_sa_confirmation') {
      return res.status(400).json({ error: 'Application is not awaiting SA confirmation' })
    }

    const history = Array.isArray(current.stage_history) ? current.stage_history : []
    const rejectionEntry = {
      type: 'sa_rejection',
      by: req.user?.id || null,
      by_name: req.user?.full_name || null,
      at: new Date().toISOString(),
      meta: { note }
    }

    const { data: updated, error: updateErr } = await supabase
      .from('applications')
      .update({
        status: 'pending',
        stage: 'approver',
        approver_proposed_amount: null,
        approver_proposed_term: null,
        approver_proposed_at: null,
        approver_proposed_by: null,
        sa_rejection_note: note,
        sa_rejection_at: new Date().toISOString(),
        sa_rejection_by: req.user?.id?.length === 36 ? req.user.id : null,
        stage_history: [...history, rejectionEntry]
      })
      .eq('id', req.params.id)
      .select()
      .single()

    if (updateErr) throw updateErr
    return res.json(updated)
  } catch (error) {
    console.error('Reject-terms error:', error.message)
    return res.status(400).json({ error: error.message })
  }
})

// Export consent report as CSV
router.get('/export/consent', requireRole('admin', 'super_admin', 'approver'), async (req, res) => {
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
router.patch('/applications/:id/decline', requireRole('admin', 'super_admin', 'approver'), async (req, res) => {
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
