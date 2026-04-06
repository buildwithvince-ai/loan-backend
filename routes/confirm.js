'use strict';

const express = require('express');
const router = express.Router();

const { supabase } = require('../services/supabase');
const { validateToken, consumeToken } = require('../services/tokens');
const { notifyApproverSODecision } = require('../services/email');

// ---------------------------------------------------------------------------
// HTML page builders
// ---------------------------------------------------------------------------

function buildPage(title, headingColor, heading, message) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — GR8 Lending</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: Arial, Helvetica, sans-serif;
      background-color: #f4f4f7;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .card {
      background: #ffffff;
      border-radius: 12px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.10);
      max-width: 480px;
      width: 100%;
      overflow: hidden;
    }
    .header {
      background-color: #1a3c6e;
      padding: 20px 28px;
    }
    .header p { color: #ffffff; font-size: 16px; font-weight: 700; margin: 0; }
    .header span { color: #a8c0e8; font-size: 12px; }
    .body {
      padding: 32px 28px;
    }
    .icon {
      font-size: 48px;
      text-align: center;
      margin-bottom: 16px;
    }
    h1 {
      font-size: 20px;
      color: ${headingColor};
      text-align: center;
      margin-bottom: 12px;
    }
    .message {
      font-size: 14px;
      color: #6b7280;
      text-align: center;
      line-height: 1.6;
    }
    .footer {
      background-color: #f9fafb;
      border-top: 1px solid #e5e7eb;
      padding: 14px 28px;
      text-align: center;
      font-size: 11px;
      color: #9ca3af;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <p>GR8 Lending Corporation</p>
      <span>gr8lendingcorporation.com</span>
    </div>
    <div class="body">
      <h1>${heading}</h1>
      <p class="message">${message}</p>
    </div>
    <div class="footer">
      You can safely close this window.
    </div>
  </div>
</body>
</html>`;
}

function invalidPage() {
  return buildPage(
    'Link Invalid',
    '#991b1b',
    'Link Unavailable',
    'This link has expired or has already been used.<br>Please contact your Sales Officer if you need assistance.'
  );
}

function successPage(action) {
  const isConfirm = action === 'confirm';
  const heading = isConfirm ? 'Response Recorded' : 'Response Recorded';
  const message = isConfirm
    ? 'Thank you. Your confirmation has been recorded. Our team will be in touch shortly.'
    : 'Thank you. Your response has been recorded. Our team has been notified.';
  const color = isConfirm ? '#065f46' : '#1a3c6e';

  return buildPage('Response Recorded', color, heading, message);
}

function errorPage() {
  return buildPage(
    'Error',
    '#991b1b',
    'Something Went Wrong',
    'We encountered an issue processing your request. Please contact GR8 Lending Corporation for assistance.'
  );
}

// ---------------------------------------------------------------------------
// GET /:token
// ---------------------------------------------------------------------------

router.get('/:token', async (req, res) => {
  const { token } = req.params;

  // 1. Validate token
  let validation;
  try {
    validation = await validateToken(token);
  } catch (err) {
    console.error('[confirm] validateToken threw unexpectedly:', err.message);
    return res.status(500).send(errorPage());
  }

  if (!validation.valid) {
    console.log(`[confirm] Invalid token — reason: ${validation.reason}`);
    return res.status(410).send(invalidPage());
  }

  const { action, application_id } = validation;

  try {
    // 2. Consume the token immediately to prevent double-use
    await consumeToken(token);

    // 3. Fetch the application
    const { data: application, error: appError } = await supabase
      .from('applications')
      .select('*')
      .eq('id', application_id)
      .single();

    if (appError || !application) {
      console.error('[confirm] Could not fetch application:', appError ? appError.message : 'not found');
      return res.status(500).send(errorPage());
    }

    // 4. Update so_decision, so_decision_at, and move stage back to approver
    const now = new Date().toISOString();

    const currentHistory = Array.isArray(application.stage_history)
      ? application.stage_history
      : [];

    const updatedHistory = [
      ...currentHistory,
      {
        event: 'so_confirmation',
        decision: action,
        at: now,
      },
    ];

    const { error: updateError } = await supabase
      .from('applications')
      .update({
        so_decision: action,
        so_decision_at: now,
        stage: 'approver',
        stage_history: updatedHistory,
      })
      .eq('id', application_id);

    if (updateError) {
      console.error('[confirm] Failed to update application:', updateError.message);
      return res.status(500).send(errorPage());
    }

    // 6. Fetch approver team (admin + super_admin, active only)
    const { data: approverTeam, error: approverError } = await supabase
      .from('admin_users')
      .select('id, email, full_name, roles')
      .or('roles.cs.{"admin"},roles.cs.{"super_admin"},roles.cs.{"approver"}')
      .eq('is_active', true);

    if (approverError) {
      console.error('[confirm] Failed to fetch approver team:', approverError.message);
      // Non-fatal — still return success page
    }

    // 7. Notify approver team (fire-and-forget, errors caught inside)
    const team = approverTeam || [];
    notifyApproverSODecision(team, application, action).catch((err) => {
      console.error('[confirm] notifyApproverSODecision background error:', err.message);
    });

    console.log(`[confirm] Token processed — application ${application_id}, action: ${action}`);

    // 8. Return branded success page
    return res.status(200).send(successPage(action));
  } catch (err) {
    console.error('[confirm] Unexpected error processing token:', err.message);
    return res.status(500).send(errorPage());
  }
});

module.exports = router;
