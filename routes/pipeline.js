'use strict';

const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabase');
const { transitionStage } = require('../services/pipeline');
const { verifyToken, requireRole } = require('../middleware/auth');

// All pipeline routes require a valid auth token
router.use(verifyToken);

// Roles permitted to read history / KYC file URLs on any application. Blocks
// tokens with no/unknown role; per-applicant ownership scoping is a follow-up.
const READ_ROLES = ['super_admin', 'admin', 'approver', 'verifier', 'ci_officer', 'sales_officer', 'loan_processing_officer'];

// ---------------------------------------------------------------------------
// PATCH /:id/transition
// Move an application to a new pipeline stage.
// Body: { to_stage: string, meta?: object }
// ---------------------------------------------------------------------------
router.patch('/:id/transition', async (req, res) => {
  try {
    const { to_stage, meta } = req.body;

    if (!to_stage) {
      return res.status(400).json({ error: 'to_stage is required' });
    }

    // Declined-tier apps stay on the admin dashboard. Override approval goes only
    // through PATCH /api/admin/applications/:id/approve (supervisor + override:true),
    // so the board's approver->loan_processing_officer path refuses them outright.
    if (to_stage === 'loan_processing_officer') {
      const { data: gateRow, error: gateErr } = await supabase
        .from('applications')
        .select('tier')
        .eq('id', req.params.id)
        .single();
      if (gateErr || !gateRow) {
        return res.status(404).json({ error: 'Application not found' });
      }
      if (gateRow.tier === 'declined') {
        return res.status(400).json({
          error: 'Declined-tier applications cannot be approved from the pipeline board. Use the application page with a supervisor override.'
        });
      }
    }

    const updated = await transitionStage(req.params.id, to_stage, req.user, meta || {});
    return res.json(updated);
  } catch (error) {
    console.error('[pipeline] transition error:', error.message);
    return res.status(400).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// GET /:id/history
// Return the stage_history array for an application.
// ---------------------------------------------------------------------------
router.get('/:id/history', requireRole(...READ_ROLES), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('applications')
      .select('stage_history')
      .eq('id', req.params.id)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Application not found' });
    }

    return res.json(data.stage_history || []);
  } catch (error) {
    console.error('[pipeline] history error:', error.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// PATCH /:id/assign-sales-officer
// Assign a sales officer to an application.
// Body: { sales_officer_id: uuid }
// Restricted to admin and super_admin.
// ---------------------------------------------------------------------------
router.patch(
  '/:id/assign-sales-officer',
  requireRole('admin', 'super_admin', 'approver'),
  async (req, res) => {
    try {
      const { sales_officer_id } = req.body;

      if (!sales_officer_id) {
        return res.status(400).json({ error: 'sales_officer_id is required' });
      }

      const { data: so, error: soError } = await supabase
        .from('admin_users')
        .select('id')
        .eq('id', sales_officer_id)
        .contains('roles', ['sales_officer'])
        .eq('is_active', true)
        .maybeSingle();

      if (soError) throw soError;
      if (!so) {
        return res.status(400).json({ error: 'sales_officer_id must be an active sales officer' });
      }

      const { data, error } = await supabase
        .from('applications')
        .update({ assigned_sales_officer: sales_officer_id })
        .eq('id', req.params.id)
        .select()
        .single();

      if (error) throw error;
      if (!data) return res.status(404).json({ error: 'Application not found' });

      return res.json(data);
    } catch (error) {
      console.error('[pipeline] assign-sales-officer error:', error.message);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ---------------------------------------------------------------------------
// POST /:id/so-confirmation
// Initiate SO confirmation email with confirm/decline tokens.
// Restricted to admin and super_admin.
// ---------------------------------------------------------------------------
router.post(
  '/:id/so-confirmation',
  requireRole('admin', 'super_admin', 'approver'),
  async (req, res) => {
    try {
      const { generateConfirmationTokens } = require('../services/tokens');
      const { sendSOConfirmationRequest, resolveSORecipients } = require('../services/email');

      // Fetch the application
      const { data: application, error: appError } = await supabase
        .from('applications')
        .select('*')
        .eq('id', req.params.id)
        .single();

      if (appError || !application) {
        return res.status(404).json({ error: 'Application not found' });
      }

      if (!application.assigned_sales_officer) {
        return res.status(400).json({ error: 'No sales officer assigned to this application' });
      }

      // Assigned SO, or every active SO if the assigned one was deactivated
      const soUsers = await resolveSORecipients(application.assigned_sales_officer);

      if (!soUsers.length) {
        return res.status(400).json({ error: 'No active sales officer to notify' });
      }

      // Generate confirm/decline tokens
      const { confirmToken, declineToken } = await generateConfirmationTokens(req.params.id);

      // Send the confirmation email — awaited intentionally (this IS the purpose of the route)
      for (const soUser of soUsers) {
        await sendSOConfirmationRequest(soUser, application, confirmToken, declineToken);
      }

      // Record the timestamp the confirmation was sent
      await supabase
        .from('applications')
        .update({ so_confirmation_sent_at: new Date().toISOString() })
        .eq('id', req.params.id);

      return res.json({ message: 'SO confirmation email sent', sent_to: soUsers.map((u) => u.email).join(', ') });
    } catch (error) {
      console.error('[pipeline] so-confirmation error:', error.message);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ---------------------------------------------------------------------------
// GET /:id/files
// Return signed URLs for all uploaded files on an application.
// URLs expire after 1 hour.
// ---------------------------------------------------------------------------
router.get('/:id/files', requireRole(...READ_ROLES), async (req, res) => {
  try {
    const { data: app, error } = await supabase
      .from('applications')
      .select('file_metadata')
      .eq('id', req.params.id)
      .single();

    if (error || !app) {
      return res.status(404).json({ error: 'Application not found' });
    }

    const files = app.file_metadata || [];

    if (files.length === 0) {
      return res.json([]);
    }

    const signed = await Promise.all(
      files.map(async (file) => {
        const { data, error: signError } = await supabase.storage
          .from('application-files')
          .createSignedUrl(file.storage_path, 3600);

        if (signError) {
          console.error('[pipeline] signedUrl error for', file.storage_path, signError.message);
        }
        return {
          name: file.original_name,
          field: file.field_name || null,
          url: signError ? null : data?.signedUrl || null,
        };
      })
    );

    return res.json(signed);
  } catch (error) {
    console.error('[pipeline] files error:', error.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
