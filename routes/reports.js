'use strict';

const express = require('express');
const multer = require('multer');
const { supabase } = require('../services/supabase');
const { verifyToken } = require('../middleware/auth');
const { sendProblemReport } = require('../services/email');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/png', 'image/jpeg', 'image/webp'];
    if (allowed.includes(file.mimetype)) return cb(null, true);
    cb(new Error('Only PNG, JPEG, and WebP images are allowed'));
  },
});

// POST /api/reports/problem
router.post(
  '/problem',
  verifyToken,
  upload.single('screenshot'),
  async (req, res) => {
    try {
      const { page, description } = req.body;

      if (!description || description.trim().length < 10) {
        return res.status(400).json({
          success: false,
          error: 'Description is required and must be at least 10 characters.',
        });
      }

      // Upload screenshot if provided
      let screenshot_url = null;
      if (req.file) {
        const filename = `${Date.now()}_${req.file.originalname}`;
        const storagePath = `${req.user.id}/${filename}`;

        const { error: uploadError } = await supabase.storage
          .from('problem-reports')
          .upload(storagePath, req.file.buffer, {
            contentType: req.file.mimetype,
            upsert: false,
          });

        if (uploadError) {
          console.error('[reports] Screenshot upload failed:', uploadError.message);
        } else {
          const { data: urlData } = supabase.storage
            .from('problem-reports')
            .getPublicUrl(storagePath);
          screenshot_url = urlData?.publicUrl || null;
        }
      }

      // Derive primary role from user's roles array
      const reported_by_role = (req.user.roles && req.user.roles[0]) || 'unknown';

      // Insert into problem_reports
      const { data: report, error: insertError } = await supabase
        .from('problem_reports')
        .insert({
          reported_by_id: req.user.id,
          reported_by_name: req.user.full_name,
          reported_by_role,
          page: page || null,
          description: description.trim(),
          screenshot_url,
        })
        .select('id, timestamp')
        .single();

      if (insertError) {
        console.error('[reports] Insert failed:', insertError.message);
        return res.status(500).json({ success: false, error: 'Failed to save report.' });
      }

      // Send email notification (fire-and-forget)
      sendProblemReport({
        reported_by_name: req.user.full_name,
        reported_by_role,
        page: page || '—',
        description: description.trim(),
        screenshot_url,
        timestamp: report.timestamp,
      });

      return res.status(201).json({ success: true, report_id: report.id });
    } catch (err) {
      // Multer file-filter errors surface here
      if (err.message === 'Only PNG, JPEG, and WebP images are allowed') {
        return res.status(400).json({ success: false, error: err.message });
      }
      console.error('[reports] Unexpected error:', err.message);
      return res.status(500).json({ success: false, error: 'Internal server error.' });
    }
  },
);

module.exports = router;
