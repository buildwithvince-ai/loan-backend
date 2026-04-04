'use strict';

const { supabase } = require('./supabase');
const { createBorrower, uploadAllFiles } = require('./loandisk');
const { notifySalesOfficer, notifyTeamByRole, notifySOReturn, notifySODecision } = require('./email');

const VALID_STAGES = [
  'sales_officer',
  'verifier',
  'ci_officer',
  'approver',
  'loan_processing_officer',
  'declined'
];

// ---------------------------------------------------------------------------
// Transition guards
// Keyed by 'from->to'. Each guard is async (application, user, meta) and
// returns { allowed: boolean, reason: string }.
// Side-effects (Loandisk push, status updates) are executed inside the guard
// when allowed, before transitionStage writes the new stage to the DB.
// ---------------------------------------------------------------------------

const TRANSITION_GUARDS = {

  'sales_officer->verifier': async (application) => {
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

  'ci_officer->approver': async (application) => {
    if (application.ci_score === null || application.ci_score === undefined) {
      return { allowed: false, reason: 'CI score must be submitted before advancing to approver' };
    }
    return { allowed: true, reason: 'Advancing to approver' };
  },

  'approver->loan_processing_officer': async (application, user) => {
    if (application.ci_score === null || application.ci_score === undefined) {
      return { allowed: false, reason: 'CI score required' };
    }

    const approveRoles = ['admin', 'super_admin', 'approver'];
    const userRoles = user.roles || [];
    if (!approveRoles.some((r) => userRoles.includes(r))) {
      return { allowed: false, reason: 'Only admins or approvers can approve applications' };
    }

    // --- Loandisk approval side effect ---
    const { data: fullApp, error: fetchError } = await supabase
      .from('applications')
      .select('form_data, file_metadata, finscore_raw')
      .eq('id', application.id)
      .single();

    if (fetchError) {
      throw new Error('Failed to fetch application data: ' + fetchError.message);
    }

    const formData = fullApp.form_data;
    const finScore = {
      score: fullApp.finscore_raw,
      riskBand: 'N/A',
      fraudFlag: 'false'
    };

    const borrowerId = await createBorrower(formData, finScore);

    // Download each file from Supabase Storage and collect for batch upload
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

    // Persist Loandisk borrower ID and mark status approved
    const { error: updateError } = await supabase
      .from('applications')
      .update({
        loandisk_borrower_id: borrowerId,
        status: 'approved'
      })
      .eq('id', application.id);

    if (updateError) {
      throw new Error('Failed to update application after Loandisk push: ' + updateError.message);
    }

    return { allowed: true, reason: 'Approved and pushed to Loandisk' };
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
    // Increment returned_count
    const currentCount = application.returned_count || 0;
    await supabase
      .from('applications')
      .update({ returned_count: currentCount + 1 })
      .eq('id', application.id);
    return { allowed: true, reason: 'Returned to sales officer' };
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

  // Write the new stage and history to the DB
  const { data: updated, error: updateError } = await supabase
    .from('applications')
    .update({
      stage: toStage,
      stage_history: updatedHistory
    })
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

module.exports = { VALID_STAGES, transitionStage };
