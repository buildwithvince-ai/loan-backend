const express = require('express')
const multer = require('multer')
const router = express.Router()
const upload = multer({ storage: multer.memoryStorage() })
const { createBorrower, uploadAllFiles } = require('../services/loandisk')
const { supabase } = require('../services/supabase')
const { compressFiles } = require('../services/compress')
const { notifySalesOfficer, notifyTeamByRole } = require('../services/email')

// Pre-qualification check
function preQualify(formData) {
  const reasons = []

  // Age check (21-65)
  if (formData.dob) {
    const dob = new Date(formData.dob)
    const today = new Date()
    let age = today.getFullYear() - dob.getFullYear()
    const m = today.getMonth() - dob.getMonth()
    if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) age--
    if (age < 21 || age > 65) {
      reasons.push('Applicant must be between 21 and 65 years old')
    }
  }

  // Income check per loan type
  const income = parseFloat(formData.monthlyIncome) || 0
  const minIncome = {
    personal: 15000,
    sme: 30000,
    akap: 10000
  }
  const required = minIncome[formData.loanType] || 0
  if (income < required) {
    reasons.push(`Minimum monthly income for this loan is ₱${required.toLocaleString()}`)
  }

  // Loan amount check
  const amount = parseFloat(formData.loanAmount) || 0
  const limits = {
    personal: { min: 10000, max: 30000 },
    sme:      { min: 50000, max: 300000 },
    akap:     { min: 5000,  max: 40000 }
  }
  const limit = limits[formData.loanType]
  if (limit && (amount < limit.min || amount > limit.max)) {
    reasons.push(`Loan amount must be between ₱${limit.min.toLocaleString()} and ₱${limit.max.toLocaleString()}`)
  }

  // Mobile format check (09XXXXXXXXX)
  if (formData.mobile && !/^09\d{9}$/.test(formData.mobile)) {
    reasons.push('Invalid mobile number format')
  }

  return reasons
}

// Test routes (keep for debugging)
router.post('/test-loandisk', async (req, res) => {
  try {
    const testFormData = {
      firstName: 'Test',
      lastName: 'Borrower',
      mobile: '09171234567',
      email: 'test@email.com',
      dob: '01/15/1990',
      address: '123 Test Street',
      barangay: 'Poblacion',
      city: 'Malolos',
      province: 'Bulacan',
      zipcode: '3000',
      employmentStatus: 'Employee'
    }
    const testFinScore = { score: 750, riskBand: '21', fraudFlag: 'false' }
    const borrowerId = await createBorrower(testFormData, testFinScore)
    return res.status(200).json({ status: 'success', borrowerId })
  } catch (error) {
    console.error('Loandisk test error:', error.message)
    return res.status(500).json({ status: 'error', message: error.message })
  }
})

router.post('/test-upload', upload.single('file'), async (req, res) => {
  try {
    const borrowerId = '7527769'
    if (!req.file) {
      return res.status(400).json({ status: 'error', message: 'No file uploaded' })
    }
    const fileIds = await uploadAllFiles(borrowerId, [req.file])
    return res.status(200).json({ status: 'success', fileIds })
  } catch (error) {
    console.error('Upload test error:', error.message)
    return res.status(500).json({ status: 'error', message: error.message })
  }
})

// Main submit route — saves to Supabase, no Loandisk until admin approval
router.post('/submit', upload.any(), async (req, res) => {
  try {
    const formData = req.body
    const files = req.files || []

    // Validate sales_officer_id if provided
    let assigned_sales_officer = null;
    if (formData.sales_officer_id) {
      const { data: soCheck } = await supabase
        .from('admin_users')
        .select('id')
        .eq('id', formData.sales_officer_id)
        .contains('roles', ['sales_officer'])
        .eq('is_active', true)
        .maybeSingle();

      if (soCheck) {
        assigned_sales_officer = soCheck.id;
      }
    }

    // Step 1 — Check for existing pending application with same phone
    const { data: existing } = await supabase
      .from('applications')
      .select('id')
      .eq('phone', formData.mobile)
      .eq('status', 'pending')
      .maybeSingle()

    if (existing) {
      return res.status(200).json({
        status: 'error',
        message: 'An application for this mobile number is already under review. Please wait for our team to contact you.'
      })
    }

    // Step 1b — Prior decline detection
    let prior_decline_flag = false
    let prior_decline_reference = null
    const { data: priorDeclined } = await supabase
      .from('applications')
      .select('reference_id')
      .eq('phone', formData.mobile)
      .eq('status', 'declined')
      .order('submitted_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (priorDeclined) {
      prior_decline_flag = true
      prior_decline_reference = priorDeclined.reference_id
    }

    // Step 2 — Pre-qualification
    const reasons = preQualify(formData)
    if (reasons.length > 0) {
      return res.status(200).json({ status: 'declined', reasons })
    }

    // Step 3 — FinScore
    const { getScore } = require('../services/finscore')
    const finScore = await getScore(formData.mobile)
    console.log('FinScore result:', JSON.stringify(finScore))

    // Step 4 — Normalize FinScore
    const finscore_raw = finScore.score || 0
    const finscore_normalized = finscore_raw === 0 ? 0 :
      Math.round(((finscore_raw - 300) / (999 - 300)) * 100)

    // Step 5 — Compress and upload files to Supabase Storage
    const reference_id = 'GR8-' + Date.now()
    const folderName = `${reference_id}_${formData.firstName}-${formData.lastName}`
    const file_metadata = []
    const compressedFiles = await compressFiles(files)

    for (const file of compressedFiles) {
      const storagePath = `${folderName}/${file.fieldname}_${file.originalname}`
      const { error: uploadError } = await supabase.storage
        .from('application-files')
        .upload(storagePath, file.buffer, {
          contentType: file.mimetype,
          upsert: false
        })

      if (uploadError) {
        console.error('File upload error:', uploadError.message)
        continue
      }

      file_metadata.push({
        field_name: file.fieldname,
        original_name: file.originalname,
        original_size: file.originalSize || file.size,
        size: file.size,
        storage_path: storagePath
      })
    }

    // Step 6 — Extract consent
    const consent_agreed = formData.consentAgreed === 'true' || formData.consentAgreed === true
    const consent_agreed_at = new Date().toISOString()

    // Step 7 — Save to Supabase

    const { error } = await supabase
      .from('applications')
      .insert({
        reference_id,
        phone: formData.mobile,
        loan_type: formData.loanType,
        full_name: formData.firstName + ' ' + formData.lastName,
        email: formData.email,
        loan_amount: formData.loanAmount,
        loan_term: formData.loanTerm,
        form_data: formData,
        finscore_raw,
        finscore_normalized,
        status: 'pending',
        stage: 'sales_officer',
        assigned_sales_officer,
        file_metadata,
        consent_agreed,
        consent_agreed_at,
        prior_decline_flag,
        prior_decline_reference
      })

    if (error) throw error

    // Email notification — errors won't fail the response
    try {
      const appRecord = { reference_id, full_name: formData.firstName + ' ' + formData.lastName, loan_type: formData.loanType, loan_amount: formData.loanAmount, phone: formData.mobile };
      if (assigned_sales_officer) {
        const { data: soUser } = await supabase
          .from('admin_users')
          .select('id, email, full_name, roles')
          .eq('id', assigned_sales_officer)
          .single();
        if (soUser) {
          await notifySalesOfficer(soUser, appRecord);
        }
      } else {
        await notifyTeamByRole('sales_officer', appRecord, { message: 'Unassigned lead needs pickup' });
      }
    } catch (hookErr) {
      console.error('[submit] Email hook error:', hookErr.message);
    }

    return res.status(200).json({
      status: 'success',
      referenceId: reference_id
    })

  } catch (error) {
    console.error('Submit error:', error.message)
    return res.status(500).json({
      status: 'error',
      message: 'Something went wrong. Please try again.'
    })
  }
})

// Group / SBL multi-member submit route
router.post('/submit-group', upload.any(), async (req, res) => {
  try {
    const { loanType, totalLoanAmount, loanTerm, groupName } = req.body
    const members = typeof req.body.members === 'string'
      ? JSON.parse(req.body.members)
      : req.body.members
    const files = req.files || []

    // Check for existing pending application with leader's phone
    const leader = members[0]

    // Validate sales_officer_id if provided
    let assigned_sales_officer = null;
    if (req.body.sales_officer_id) {
      const { data: soCheck } = await supabase
        .from('admin_users')
        .select('id')
        .eq('id', req.body.sales_officer_id)
        .contains('roles', ['sales_officer'])
        .eq('is_active', true)
        .maybeSingle();

      if (soCheck) {
        assigned_sales_officer = soCheck.id;
      }
    }

    const { data: existing } = await supabase
      .from('applications')
      .select('id')
      .eq('phone', leader.mobile)
      .eq('status', 'pending')
      .maybeSingle()

    if (existing) {
      return res.status(200).json({
        status: 'error',
        message: 'An application for this mobile number is already under review. Please wait for our team to contact you.'
      })
    }

    // Prior decline detection for group leader
    let prior_decline_flag = false
    let prior_decline_reference = null
    const { data: priorDeclinedGroup } = await supabase
      .from('applications')
      .select('reference_id')
      .eq('phone', leader.mobile)
      .eq('status', 'declined')
      .order('submitted_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (priorDeclinedGroup) {
      prior_decline_flag = true
      prior_decline_reference = priorDeclinedGroup.reference_id
    }

    // Validate member count
    if (loanType === 'group' && members.length < 5) {
      return res.status(200).json({ status: 'declined', reasons: ['Group Loan requires at least 5 members'] })
    }
    if (loanType === 'sbl' && members.length < 1) {
      return res.status(200).json({ status: 'declined', reasons: ['SBL requires at least 1 member'] })
    }

    // Validate total loan amount
    const amount = parseFloat(totalLoanAmount) || 0
    const limits = {
      group: { min: 10000, max: 50000 },
      sbl: { min: 5000, max: 100000 }
    }
    const limit = limits[loanType]
    if (limit && (amount < limit.min || amount > limit.max)) {
      return res.status(200).json({
        status: 'declined',
        reasons: [`Loan amount must be between ₱${limit.min.toLocaleString()} and ₱${limit.max.toLocaleString()}`]
      })
    }

    // Validate each member
    const memberErrors = []
    members.forEach((member, i) => {
      // Age check
      if (member.dob) {
        const dob = new Date(member.dob)
        const today = new Date()
        let age = today.getFullYear() - dob.getFullYear()
        const m = today.getMonth() - dob.getMonth()
        if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) age--
        if (age < 21 || age > 65) {
          memberErrors.push(`Member ${i + 1}: Must be between 21 and 65 years old`)
        }
      }
      // Mobile check
      if (member.mobile && !/^09\d{9}$/.test(member.mobile)) {
        memberErrors.push(`Member ${i + 1}: Invalid mobile number format`)
      }
    })
    if (memberErrors.length > 0) {
      return res.status(200).json({ status: 'declined', reasons: memberErrors })
    }

    // FinScore for leader (first member)
    const { getScore } = require('../services/finscore')
    let finScore = { score: 0, riskBand: 'N/A', fraudFlag: 'false', noScore: true }
    try {
      finScore = await getScore(leader.mobile)
      console.log('[Group] Leader FinScore:', JSON.stringify(finScore))
    } catch (err) {
      console.error('[Group] Leader FinScore failed:', err.message)
    }

    const finscore_raw = finScore.score || 0
    const finscore_normalized = finscore_raw === 0 ? 0 :
      Math.round(((finscore_raw - 300) / (999 - 300)) * 100)

    const reference_id = 'GR8-' + Date.now()
    const folderName = `${reference_id}_${leader.firstName}-${leader.lastName}`

    const file_metadata = []
    const compressedFiles = await compressFiles(files)

    for (const file of compressedFiles) {
      const storagePath = `${folderName}/${file.fieldname}_${file.originalname}`
      const { error: uploadError } = await supabase.storage
        .from('application-files')
        .upload(storagePath, file.buffer, {
          contentType: file.mimetype,
          upsert: false
        })

      if (uploadError) {
        console.error('File upload error:', uploadError.message)
        continue
      }

      file_metadata.push({
        field_name: file.fieldname,
        original_name: file.originalname,
        original_size: file.originalSize || file.size,
        size: file.size,
        storage_path: storagePath
      })
    }

    const consent_agreed = req.body.consentAgreed === 'true' || req.body.consentAgreed === true
    const consent_agreed_at = new Date().toISOString()

    // Build one row per member — leader gets base ref, co-members get suffixed refs
    const base_reference_id = reference_id
    const groupMeta = { loanType, totalLoanAmount, loanTerm, groupName, base_reference_id, total_members: members.length }

    const rows = members.map((member, i) => {
      const isLeader = i === 0
      const memberRef = isLeader ? base_reference_id : `${base_reference_id}-M${i}`
      return {
        reference_id: memberRef,
        phone: member.mobile,
        loan_type: loanType,
        full_name: (member.firstName || '') + ' ' + (member.lastName || ''),
        email: member.email || '',
        loan_amount: totalLoanAmount,
        loan_term: loanTerm,
        form_data: { ...groupMeta, member_index: i, is_leader: isLeader, ...member },
        finscore_raw,
        finscore_normalized,
        status: 'pending',
        stage: 'sales_officer',
        assigned_sales_officer,
        file_metadata,
        group_members: members,
        consent_agreed,
        consent_agreed_at,
        prior_decline_flag: isLeader ? prior_decline_flag : false,
        prior_decline_reference: isLeader ? prior_decline_reference : null
      }
    })

    const { error } = await supabase
      .from('applications')
      .insert(rows)

    if (error) throw error

    // Email notification — errors won't fail the response
    try {
      const appRecord = { reference_id: base_reference_id, full_name: leader.firstName + ' ' + leader.lastName, loan_type: loanType, loan_amount: totalLoanAmount, phone: leader.mobile };
      if (assigned_sales_officer) {
        const { data: soUser } = await supabase
          .from('admin_users')
          .select('id, email, full_name, roles')
          .eq('id', assigned_sales_officer)
          .single();
        if (soUser) {
          await notifySalesOfficer(soUser, appRecord);
        }
      } else {
        await notifyTeamByRole('sales_officer', appRecord, { message: 'Unassigned lead needs pickup' });
      }
    } catch (hookErr) {
      console.error('[submit-group] Email hook error:', hookErr.message);
    }

    return res.status(200).json({
      status: 'success',
      referenceId: base_reference_id,
      totalMembers: members.length
    })

  } catch (error) {
    console.error('Group submit error:', error.message)
    return res.status(500).json({
      status: 'error',
      message: 'Something went wrong. Please try again.'
    })
  }
})

router.post('/test-finscore', async (req, res) => {
  try {
    const { getScore } = require('../services/finscore')
    const { mobile } = req.body
    if (!mobile) {
      return res.status(400).json({ status: 'error', message: 'mobile is required' })
    }
    const result = await getScore(mobile)
    return res.status(200).json({ status: 'success', result })
  } catch (error) {
    console.error('FinScore test error:', error.message)
    return res.status(500).json({ status: 'error', message: error.message })
  }
})

// ---------------------------------------------------------------------------
// Delete test applications by phone prefix
// DELETE /api/application/test-cleanup?prefix=0917
// ---------------------------------------------------------------------------
router.delete('/test-cleanup', async (req, res) => {
  try {
    const prefix = req.query.prefix;
    if (!prefix || !prefix.startsWith('0917')) {
      return res.status(400).json({ status: 'error', message: 'prefix query param required (must start with 0917)' });
    }

    const { data, error } = await supabase
      .from('applications')
      .delete()
      .like('phone', `${prefix}%`)
      .select('id');

    if (error) throw error;

    return res.json({ status: 'success', deleted: data ? data.length : 0 });
  } catch (error) {
    console.error('Test cleanup error:', error.message);
    return res.status(500).json({ status: 'error', message: error.message });
  }
});

// ---------------------------------------------------------------------------
// Test email automation
// POST /api/application/test-email
// Body: { to, template }
// Templates: sales_officer, team_unassigned, team_verifier, team_ci,
//   team_approver, team_lpo, so_return, so_decision_approved,
//   so_decision_declined_verification, so_decision_declined_approval,
//   confirmation, approver_so_decision
// ---------------------------------------------------------------------------
router.post('/test-email', async (req, res) => {
  try {
    const {
      sendEmail,
      notifySalesOfficer,
      notifySOReturn,
      notifySODecision,
      sendSOConfirmationRequest,
      notifyApproverSODecision,
    } = require('../services/email');

    const { to, template } = req.body;
    if (!to) {
      return res.status(400).json({ status: 'error', message: 'to (email address) is required' });
    }

    const mockApp = {
      id: 'test-uuid',
      reference_id: 'GR8-TEST-001',
      full_name: 'Juan Dela Cruz',
      loan_type: 'Personal',
      loan_amount: 25000,
      loan_term: 12,
      phone: '09171234567',
      final_score: 78.50,
      tier: 'tier_b',
      ci_recommended_amount: 20000,
      assigned_sales_officer_name: 'Test Sales Officer',
      stage_history: [],
    };

    const mockUser = { id: 'test-so-id', email: to, full_name: 'Test Sales Officer', roles: ['sales_officer'] };

    const selected = template || 'all';

    // Helper to build role-specific team emails directly (bypasses DB lookup)
    const { default: axios } = require('axios');
    const buildTeamEmail = async (role) => {
      // We call sendEmail directly with the same logic notifyTeamByRole uses,
      // but skip the DB user lookup so we can test the template rendering.
      const emailMod = require('../services/email');
      // Temporarily override — send directly to test address
      const roleSubjects = {
        sales_officer: `Unassigned Application: ${mockApp.reference_id}`,
        verifier: `New Application for Verification: ${mockApp.reference_id}`,
        ci_officer: `New Application for CI: ${mockApp.reference_id}`,
        approver: `Application Ready for Approval: ${mockApp.reference_id}`,
        loan_processing_officer: `Application Approved — Ready for Processing: ${mockApp.reference_id}`,
      };
      const roleIntros = {
        sales_officer: 'A new application has been submitted without an assigned Sales Officer.',
        verifier: 'An application is ready for your verification.',
        ci_officer: 'An application has passed verification and is ready for Credit Investigation.',
        approver: 'An application has completed Credit Investigation and is ready for final review.',
        loan_processing_officer: 'The following application has been approved and is ready for loan processing and fund release.',
      };
      const roleCtas = {
        sales_officer: 'Please assign this lead immediately.',
        verifier: 'Log in to the dashboard to proceed.',
        ci_officer: 'Log in to the CI portal to proceed.',
        approver: 'Log in to the dashboard to review scores and make a decision.',
        loan_processing_officer: 'Log in to the dashboard to proceed.',
      };

      // Use raw sendEmail to bypass the DB user lookup
      await emailMod.sendEmail({
        to,
        subject: roleSubjects[role],
        htmlBody: buildTestTeamHtml(roleIntros[role], mockApp, roleCtas[role]),
      });
    };

    const VALID_TEMPLATES = [
      'all', 'sales_officer', 'team_unassigned', 'team_verifier', 'team_ci',
      'team_approver', 'team_lpo', 'so_return', 'so_decision_approved',
      'so_decision_declined_verification', 'so_decision_declined_approval',
      'confirmation', 'approver_so_decision',
    ];

    if (!VALID_TEMPLATES.includes(selected)) {
      return res.status(400).json({
        status: 'error',
        message: `Unknown template: ${selected}. Valid: ${VALID_TEMPLATES.join(', ')}`,
      });
    }

    const results = [];

    const run = async (name, fn) => {
      await fn();
      results.push(name);
    };

    if (selected === 'all' || selected === 'sales_officer') {
      await run('sales_officer', () => notifySalesOfficer(mockUser, mockApp));
    }
    if (selected === 'all' || selected === 'team_unassigned') {
      await run('team_unassigned', () => buildTeamEmail('sales_officer'));
    }
    if (selected === 'all' || selected === 'team_verifier') {
      await run('team_verifier', () => buildTeamEmail('verifier'));
    }
    if (selected === 'all' || selected === 'team_ci') {
      await run('team_ci', () => buildTeamEmail('ci_officer'));
    }
    if (selected === 'all' || selected === 'team_approver') {
      await run('team_approver', () => buildTeamEmail('approver'));
    }
    if (selected === 'all' || selected === 'team_lpo') {
      await run('team_lpo', () => buildTeamEmail('loan_processing_officer'));
    }
    if (selected === 'all' || selected === 'so_return') {
      await run('so_return', () => notifySOReturn(mockUser, mockApp, 'Missing income documents — please re-upload.'));
    }
    if (selected === 'all' || selected === 'so_decision_approved') {
      await run('so_decision_approved', () => notifySODecision(mockUser, mockApp, 'Approved'));
    }
    if (selected === 'all' || selected === 'so_decision_declined_verification') {
      const appWithVerifierHistory = { ...mockApp, stage_history: [{ from: 'verifier', to: 'declined' }] };
      await run('so_decision_declined_verification', () => notifySODecision(mockUser, appWithVerifierHistory, 'Declined'));
    }
    if (selected === 'all' || selected === 'so_decision_declined_approval') {
      const appWithApproverHistory = { ...mockApp, stage_history: [{ from: 'approver', to: 'declined' }] };
      await run('so_decision_declined_approval', () => notifySODecision(mockUser, appWithApproverHistory, 'Declined'));
    }
    if (selected === 'all' || selected === 'confirmation') {
      await run('confirmation', () => sendSOConfirmationRequest(mockUser, mockApp, 'test-confirm-token', 'test-decline-token'));
    }
    if (selected === 'all' || selected === 'approver_so_decision') {
      await run('approver_so_decision', () => notifyApproverSODecision([mockUser], mockApp, 'confirm'));
    }

    return res.status(200).json({
      status: 'success',
      message: `Sent ${results.length} test email(s) to ${to}`,
      templates_sent: results,
    });
  } catch (error) {
    console.error('Email test error:', error.message);
    return res.status(500).json({ status: 'error', message: error.message });
  }
});

// Helper for test endpoint — builds team notification HTML without DB lookup
function buildTestTeamHtml(intro, application, cta) {
  const DASHBOARD_URL = 'https://gr8lendingcorporation.com/admin';
  return `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#f4f4f7;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f7;padding:32px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
        <tr><td style="background-color:#1a3c6e;padding:24px 32px;">
          <p style="margin:0;font-size:20px;font-weight:700;color:#ffffff;letter-spacing:0.5px;">GR8 Lending Corporation</p>
          <p style="margin:4px 0 0;font-size:12px;color:#a8c0e8;">gr8lendingcorporation.com</p>
        </td></tr>
        <tr><td style="padding:32px;">
          <p style="margin:0 0 16px;font-size:14px;color:#374151;">Hi Team,</p>
          <p style="margin:0 0 8px;font-size:14px;color:#374151;">${intro}</p>
          <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:16px 0;">
            <tr><td style="padding:6px 0;font-size:14px;color:#374151;"><strong>Applicant:</strong> ${application.full_name || '—'}</td></tr>
            <tr><td style="padding:6px 0;font-size:14px;color:#374151;"><strong>Loan Type:</strong> ${application.loan_type || '—'}</td></tr>
            <tr><td style="padding:6px 0;font-size:14px;color:#374151;"><strong>Phone:</strong> ${application.phone || '—'}</td></tr>
            <tr><td style="padding:6px 0;font-size:14px;color:#374151;"><strong>Reference ID:</strong> ${application.reference_id || '—'}</td></tr>
          </table>
          <p style="margin:0 0 8px;font-size:14px;color:#374151;">${cta}</p>
          <p style="margin:24px 0 0;">
            <a href="${DASHBOARD_URL}" target="_blank"
               style="display:inline-block;background-color:#1a3c6e;color:#ffffff;font-size:14px;
                      font-weight:600;text-decoration:none;padding:12px 24px;border-radius:6px;">
              Log in to Dashboard
            </a>
          </p>
          <p style="margin:24px 0 0;font-size:14px;color:#374151;">GR8 Lending Corporation</p>
        </td></tr>
        <tr><td style="background-color:#f9fafb;border-top:1px solid #e5e7eb;padding:16px 32px;">
          <p style="margin:0;font-size:11px;color:#9ca3af;text-align:center;">This is an automated notification from GR8 Lending Corporation.<br>Please do not reply to this email.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`.trim();
}

module.exports = router