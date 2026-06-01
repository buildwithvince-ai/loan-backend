'use strict';

const { supabase } = require('./supabase');
const { createBorrower, createLoan, uploadAllFiles } = require('./loandisk');
const { notifySalesOfficer, notifyTeamByRole, notifySOReturn, notifySODecision } = require('./email');
const { getProductConfig, getDefaultInterestRate, LOAN_DEFAULTS } = require('../config/loanProducts');

const VALID_STAGES = [
  'sales_officer',
  'verifier',
  'ci_officer',
  'approver',
  'loan_processing_officer',
  'declined'
];

// ---------------------------------------------------------------------------
// executeLoandiskApproval
//
// Runs the full Loandisk approval side effect for an application:
//   1. Resolve loan inputs (principal, term, rate, scheme) from `meta`,
//      falling back to the application row.
//   2. Reuse linked Loandisk borrower for renewals; create one otherwise.
//   3. Upload Supabase-stored files into the Loandisk borrower.
//   4. Create the Loandisk loan record (fees included, disbursement skipped).
//   5. Persist borrower id, loan id, fee snapshot and approved terms.
//
// Used by:
//   - approver->loan_processing_officer guard (direct approval, no diff)
//   - confirm-terms admin route (SA-confirmed adjusted terms)
// ---------------------------------------------------------------------------
async function executeLoandiskApproval(application, user, meta = {}) {
  const { data: fullApp, error: fetchError } = await supabase
    .from('applications')
    .select('form_data, file_metadata, finscore_raw, loan_type, loan_amount, loan_term, reference_id, application_category, linked_borrower_id, loandisk_borrower_id, loandisk_loan_id, approver_proposed_amount, approver_proposed_term')
    .eq('id', application.id)
    .single();

  if (fetchError) {
    throw new Error('Failed to fetch application data: ' + fetchError.message);
  }

  // Idempotency: a prior approval already created the Loandisk loan. Skip the
  // entire side-effect (borrower reuse, file upload, createLoan) to prevent
  // duplicate loan records when this runs twice (re-approval race, or the
  // confirm-terms admin route firing after a direct approval).
  if (fullApp.loandisk_loan_id) {
    console.log('[pipeline:approve] idempotent skip — Loandisk loan already exists', {
      application_id: application.id,
      loandisk_borrower_id: fullApp.loandisk_borrower_id,
      loandisk_loan_id: fullApp.loandisk_loan_id
    });
    return;
  }

  const formData = fullApp.form_data;
  const finScore = {
    score: fullApp.finscore_raw,
    riskBand: 'N/A',
    fraudFlag: 'false'
  };

  const productCfg = getProductConfig(fullApp.loan_type);
  if (!productCfg) {
    throw new Error(`Unknown loan_type "${fullApp.loan_type}" — cannot map to Loandisk product`);
  }

  // Principal/duration: prefer meta override, then SA-confirmed proposed
  // values on the row, then the persisted loan_amount/loan_term.
  const principal = Number(meta.principal ?? fullApp.approver_proposed_amount ?? fullApp.loan_amount);
  const duration_months = Number(meta.duration_months ?? fullApp.approver_proposed_term ?? fullApp.loan_term);
  // Per-loan-type default interest rate (Personal 3.5, SME 3.0, AKAP 4.0,
  // Group/SBL 5.0). Overridable when approver passes meta.interest_rate.
  const defaultRate = getDefaultInterestRate(fullApp.loan_type);
  const interest_rate = meta.interest_rate != null ? Number(meta.interest_rate) : defaultRate;
  const payment_scheme_id = meta.payment_scheme_id != null
    ? Number(meta.payment_scheme_id)
    : productCfg.default_payment_scheme;
  const discount_reason = meta.discount_reason || null;

  // Discount gate: rate below the per-type default requires a documented reason.
  if (interest_rate < defaultRate && !discount_reason) {
    throw new Error(`discount_reason is required when interest_rate is below the ${fullApp.loan_type} default (${defaultRate}%)`);
  }

  // Renewal reuse: use linked Loandisk borrower id when present and skip
  // the createBorrower call. Falls back to creating a new borrower for
  // `new` applications (or renewals missing a link, though /submit blocks that).
  let borrowerId;
  const isRenewal = fullApp.application_category === 'renewal' && fullApp.linked_borrower_id;
  if (isRenewal) {
    borrowerId = fullApp.linked_borrower_id;
    console.log('[pipeline:approve] renewal — reusing Loandisk borrower', { application_id: application.id, borrowerId });
  } else if (fullApp.loandisk_borrower_id) {
    // Idempotency: prior approval attempt already created the borrower.
    borrowerId = fullApp.loandisk_borrower_id;
    console.log('[pipeline:approve] reusing existing Loandisk borrower', { application_id: application.id, borrowerId });
  } else {
    borrowerId = await createBorrower(formData, finScore);
  }

  // Files: only upload for fresh borrowers. Renewals already have docs in Loandisk.
  if (!isRenewal) {
    const fileMetadata = fullApp.file_metadata || [];
    if (fileMetadata.length > 0) {
      const filesToUpload = [];
      for (const fileMeta of fileMetadata) {
        const { data: fileData, error: downloadError } = await supabase.storage
          .from('application-files')
          .download(fileMeta.storage_path);

        if (downloadError) {
          console.error(`Failed to download ${fileMeta.original_name}:`, downloadError.message);
          continue;
        }

        const buffer = Buffer.from(await fileData.arrayBuffer());
        filesToUpload.push({
          originalname: fileMeta.original_name,
          buffer
        });
      }

      if (filesToUpload.length > 0) {
        await uploadAllFiles(borrowerId, filesToUpload);
        console.log(`Uploaded ${filesToUpload.length} files to Loandisk for borrower ${borrowerId}`);
      }
    }
  }

  let loanResult;
  try {
    loanResult = await createLoan({
      borrower_id: borrowerId,
      loan_type: fullApp.loan_type,
      principal,
      duration_months,
      interest_rate,
      payment_scheme_id,
      discount_reason,
      loan_application_id: fullApp.reference_id,
      approver_id: user.id
    });
  } catch (loanErr) {
    console.error('[pipeline:approve] createLoan failed after borrower resolved', {
      borrower_id: borrowerId,
      application_id: application.id,
      error: loanErr.message
    });
    throw new Error('Borrower resolved but loan creation failed: ' + loanErr.message);
  }

  const { error: updateError } = await supabase
    .from('applications')
    .update({
      loandisk_borrower_id: borrowerId,
      loandisk_loan_id: loanResult.loan_id,
      approved_interest_rate: interest_rate,
      discount_reason,
      payment_scheme_id,
      num_of_repayments: loanResult.num_of_repayments,
      service_fee_amount: loanResult.fees.service_fee,
      insurance_fee_amount: loanResult.fees.insurance_fee,
      total_fees_amount: loanResult.fees.total_fees,
      net_disbursement_amount: loanResult.fees.net_disbursement,
      total_interest_amount: loanResult.total_interest,
      loan_released_at: new Date().toISOString(),
      status: 'approved'
    })
    .eq('id', application.id);

  if (updateError) {
    throw new Error('Failed to update application after Loandisk push: ' + updateError.message);
  }
}

// ---------------------------------------------------------------------------
// Transition guards
// Keyed by 'from->to'. Each guard is async (application, user, meta) and
// returns { allowed: boolean, reason: string }.
// Side-effects (Loandisk push, status updates) are executed inside the guard
// when allowed, before transitionStage writes the new stage to the DB.
// ---------------------------------------------------------------------------

const TRANSITION_GUARDS = {

  'sales_officer->verifier': async (application, user) => {
    const permitted = ['sales_officer', 'admin', 'super_admin'];
    const userRoles = user.roles || [];
    if (!permitted.some((r) => userRoles.includes(r))) {
      return { allowed: false, reason: 'Only sales officers or admins can advance to verifier' };
    }
    if (!application.assigned_sales_officer) {
      return { allowed: false, reason: 'Sales officer must be assigned before advancing' };
    }
    return { allowed: true, reason: 'Advancing to verifier' };
  },

  'verifier->ci_officer': async (application, user) => {
    const permitted = ['verifier', 'admin', 'super_admin'];
    const userRoles = user.roles || [];
    if (!permitted.some((r) => userRoles.includes(r))) {
      return { allowed: false, reason: 'Only verifiers or admins can advance to CI stage' };
    }
    return { allowed: true, reason: 'Advancing to CI officer' };
  },

  'ci_officer->approver': async (application, user) => {
    const permitted = ['ci_officer', 'admin', 'super_admin'];
    const userRoles = user.roles || [];
    if (!permitted.some((r) => userRoles.includes(r))) {
      return { allowed: false, reason: 'Only CI officers or admins can advance to approver' };
    }
    if (application.ci_score === null || application.ci_score === undefined) {
      return { allowed: false, reason: 'CI score must be submitted before advancing to approver' };
    }
    return { allowed: true, reason: 'Advancing to approver' };
  },

  'approver->loan_processing_officer': async (application, user, meta = {}) => {
    if (application.ci_score === null || application.ci_score === undefined) {
      return { allowed: false, reason: 'CI score required' };
    }

    const approveRoles = ['admin', 'super_admin', 'approver'];
    const userRoles = user.roles || [];
    if (!approveRoles.some((r) => userRoles.includes(r))) {
      return { allowed: false, reason: 'Only admins or approvers can approve applications' };
    }

    try {
      await executeLoandiskApproval(application, user, meta);
    } catch (err) {
      throw err;
    }

    return { allowed: true, reason: 'Approved and pushed to Loandisk' };
  },

  'sales_officer->approver': async (application, user, meta) => {
    const permitted = ['sales_officer', 'admin', 'super_admin'];
    const userRoles = user.roles || [];
    if (!permitted.some((r) => userRoles.includes(r))) {
      return { allowed: false, reason: 'Only sales officers or admins can submit an SO decision' };
    }
    if (!meta || !meta.so_decision) {
      return { allowed: false, reason: 'so_decision is required (confirm or decline)' };
    }
    if (!['confirm', 'decline'].includes(meta.so_decision)) {
      return { allowed: false, reason: 'so_decision must be confirm or decline' };
    }
    return { allowed: true, reason: 'SO decision submitted' };
  },

  'verifier->sales_officer': async (application, user, meta) => {
    const permitted = ['verifier', 'admin', 'super_admin'];
    const userRoles = user.roles || [];
    if (!permitted.some((r) => userRoles.includes(r))) {
      return { allowed: false, reason: 'Only verifiers or admins can return applications' };
    }
    if (!meta || !meta.return_reason) {
      return { allowed: false, reason: 'Return reason is required' };
    }

    // Verifier->SO always means a rework return: the verifier needs missing
    // info/requirements. The SO completes it and re-endorses back to the
    // verifier for re-check. Track the reason + count so the SO board can
    // surface "returned for rework" and show what to fix.
    //
    // Client-confirmation (the client's go-ahead before final approval) is an
    // APPROVER-only action via POST /pipeline/:id/so-confirmation — it sets
    // so_confirmation_sent_at directly and never routes through this transition.
    const currentCount = application.returned_count || 0;
    const { error: trackError } = await supabase
      .from('applications')
      .update({
        returned_count: currentCount + 1,
        last_return_reason: meta.return_reason,
        last_returned_at: new Date().toISOString()
      })
      .eq('id', application.id);
    if (trackError) {
      throw new Error('Failed to record rework return: ' + trackError.message);
    }
    return { allowed: true, reason: 'Returned to sales officer for rework' };
  },

  'approver->declined': async (application, user, meta) => {
    const declineRoles = ['admin', 'super_admin', 'approver'];
    const userRoles = user.roles || [];
    if (!declineRoles.some((r) => userRoles.includes(r))) {
      return { allowed: false, reason: 'Only admins or approvers can decline' };
    }

    if (!meta || !meta.decline_reason) {
      return { allowed: false, reason: 'Decline reason is required' };
    }

    // Persist declined status; reuse reviewed_at as the declined_at timestamp
    const { error: updateError } = await supabase
      .from('applications')
      .update({
        status: 'declined',
        reviewed_at: new Date().toISOString()
      })
      .eq('id', application.id);

    if (updateError) {
      throw new Error('Failed to update application to declined: ' + updateError.message);
    }

    return { allowed: true, reason: 'Application declined' };
  }
};

// ---------------------------------------------------------------------------
// transitionStage
// ---------------------------------------------------------------------------

/**
 * Transition an application to a new pipeline stage.
 *
 * @param {string} appId    - UUID of the application
 * @param {string} toStage  - Target stage (must be in VALID_STAGES)
 * @param {object} user     - Authenticated user from req.user { id, email, role, full_name }
 * @param {object} meta     - Optional metadata (e.g. { decline_reason })
 * @returns {object}        - The updated application row
 * @throws {Error}          - With a human-readable reason if the transition is blocked
 */
const transitionStage = async (appId, toStage, user, meta = {}) => {
  // Validate target stage exists in the pipeline
  if (!VALID_STAGES.includes(toStage)) {
    throw new Error('Invalid stage transition');
  }

  // Fetch current application
  const { data: application, error: fetchError } = await supabase
    .from('applications')
    .select('*')
    .eq('id', appId)
    .single();

  if (fetchError || !application) {
    throw new Error('Application not found');
  }

  const currentStage = application.stage || 'sales_officer';

  const fromIndex = VALID_STAGES.indexOf(currentStage);
  const toIndex = VALID_STAGES.indexOf(toStage);

  // Block backward moves, unless an explicit guard exists for this specific pair
  if (toIndex < fromIndex) {
    const backwardGuardKey = `${currentStage}->${toStage}`;
    if (!TRANSITION_GUARDS[backwardGuardKey]) {
      throw new Error('Backward stage transitions are not allowed');
    }
    // Guard exists — fall through to normal guard execution below
  }

  // Same stage is a no-op but still blocked to keep history clean
  if (toIndex === fromIndex) {
    throw new Error('Application is already at the requested stage');
  }

  // Look up guard for this specific transition
  const guardKey = `${currentStage}->${toStage}`;
  const guard = TRANSITION_GUARDS[guardKey];

  if (!guard) {
    throw new Error('Invalid stage transition');
  }

  // Run the guard (may execute side effects internally)
  const result = await guard(application, user, meta);

  if (!result.allowed) {
    throw new Error(result.reason);
  }

  // Build the new stage_history entry
  const existingHistory = Array.isArray(application.stage_history)
    ? application.stage_history
    : [];

  const historyEntry = {
    from: currentStage,
    to: toStage,
    by: user.id,
    by_name: user.full_name,
    at: new Date().toISOString(),
    meta: meta || {}
  };

  const updatedHistory = [...existingHistory, historyEntry];

  // Build the update payload — conditionally include SO-related timestamps
  const updatePayload = {
    stage: toStage,
    stage_history: updatedHistory
  };

  // Note: client-confirmation (so_confirmation_sent_at) is set only by the
  // approver-only route POST /pipeline/:id/so-confirmation — never here.
  // verifier->sales_officer is always a rework return (see the guard above).

  if (toStage === 'approver' && meta.so_decision) {
    updatePayload.so_decision = meta.so_decision;
    updatePayload.so_decision_at = new Date().toISOString();
  }

  // Write the new stage and history to the DB
  const { data: updated, error: updateError } = await supabase
    .from('applications')
    .update(updatePayload)
    .eq('id', appId)
    .select()
    .single();

  if (updateError) {
    throw new Error('Failed to update stage: ' + updateError.message);
  }

  // Fire-and-forget automation hooks — email failures must never break the response
  (async () => {
    try {
      if (toStage === 'sales_officer') {
        // Triggered on verifier->sales_officer return
        let soUser = null;
        if (updated.assigned_sales_officer) {
          const { data: fetchedSO } = await supabase
            .from('admin_users')
            .select('id, email, full_name, roles')
            .eq('id', updated.assigned_sales_officer)
            .single();
          soUser = fetchedSO || null;
        }

        if (soUser) {
          // If this is a return (has return_reason), send the return notification
          if (meta && meta.return_reason) {
            notifySOReturn(soUser, updated, meta.return_reason);
          } else {
            notifySalesOfficer(soUser, updated);
          }
        } else {
          notifyTeamByRole('sales_officer', updated, { message: 'Unassigned lead needs pickup' });
        }

      } else if (toStage === 'verifier') {
        notifyTeamByRole('verifier', updated, { message: 'New application ready for verification' });

      } else if (toStage === 'ci_officer') {
        notifyTeamByRole('ci_officer', updated, { message: 'New application ready for CI' });

      } else if (toStage === 'approver') {
        // Notify all approver roles
        notifyTeamByRole('admin', updated, { message: 'Application ready for final review' });
        notifyTeamByRole('super_admin', updated, { message: 'Application ready for final review' });
        notifyTeamByRole('approver', updated, { message: 'Application ready for final review' });

      } else if (toStage === 'loan_processing_officer') {
        notifyTeamByRole('loan_processing_officer', updated, { message: 'Application approved — ready for processing' });
        // Also notify the assigned SO of the approval decision
        if (updated.assigned_sales_officer) {
          const { data: soUser } = await supabase
            .from('admin_users')
            .select('id, email, full_name, roles')
            .eq('id', updated.assigned_sales_officer)
            .single();
          if (soUser) {
            notifySODecision(soUser, updated, 'Approved');
          }
        }

      } else if (toStage === 'declined') {
        if (updated.assigned_sales_officer) {
          const { data: soUser } = await supabase
            .from('admin_users')
            .select('id, email, full_name, roles')
            .eq('id', updated.assigned_sales_officer)
            .single();
          if (soUser) {
            notifySODecision(soUser, updated, 'Declined');
          }
        }
      }
    } catch (hookErr) {
      console.error('[pipeline] Automation hook error:', hookErr.message);
    }
  })();

  return updated;
};

module.exports = { VALID_STAGES, transitionStage, executeLoandiskApproval };
