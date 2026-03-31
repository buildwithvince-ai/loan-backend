'use strict';

const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabase');
const { transitionStage } = require('../services/pipeline');
const { verifyToken, requireRole } = require('../middleware/auth');

// All pipeline routes require a valid auth token
router.use(verifyToken);

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
router.get('/:id/history', async (req, res) => {
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
    return res.status(500).json({ error: error.message });
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
  requireRole('admin', 'super_admin'),
  async (req, res) => {
    try {
      const { sales_officer_id } = req.body;

      if (!sales_officer_id) {
        return res.status(400).json({ error: 'sales_officer_id is required' });
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
      return res.status(500).json({ error: error.message });
    }
  }
);

module.exports = router;
