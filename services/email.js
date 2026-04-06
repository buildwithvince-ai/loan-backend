'use strict';

const axios = require('axios');
const { supabase } = require('./supabase');

const ZEPTOMAIL_API = process.env.ZEPTO_API_URL || 'https://api.zeptomail.com/v1.1/email';
const DASHBOARD_URL = 'https://gr8lendingcorporation.com/admin';

// ---------------------------------------------------------------------------
// Shared HTML utilities
// ---------------------------------------------------------------------------

function buildEmailWrapper(bodyContent) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GR8 Lending Corporation</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f4f7;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f7;padding:32px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
          <!-- Header -->
          <tr>
            <td style="background-color:#1a3c6e;padding:24px 32px;">
              <p style="margin:0;font-size:20px;font-weight:700;color:#ffffff;letter-spacing:0.5px;">GR8 Lending Corporation</p>
              <p style="margin:4px 0 0;font-size:12px;color:#a8c0e8;">gr8lendingcorporation.com</p>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:32px;">
              ${bodyContent}
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background-color:#f9fafb;border-top:1px solid #e5e7eb;padding:16px 32px;">
              <p style="margin:0;font-size:11px;color:#9ca3af;text-align:center;">
                This is an automated notification from GR8 Lending Corporation.<br>
                Please do not reply to this email.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`.trim();
}

function buildAppDetails(application) {
  return `
  <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:16px 0;">
    <tr>
      <td style="padding:6px 0;font-size:14px;color:#374151;"><strong>Applicant:</strong> ${application.full_name || '—'}</td>
    </tr>
    <tr>
      <td style="padding:6px 0;font-size:14px;color:#374151;"><strong>Loan Type:</strong> ${application.loan_type || '—'}</td>
    </tr>
    <tr>
      <td style="padding:6px 0;font-size:14px;color:#374151;"><strong>Phone:</strong> ${application.phone || '—'}</td>
    </tr>
    <tr>
      <td style="padding:6px 0;font-size:14px;color:#374151;"><strong>Reference ID:</strong> ${application.reference_id || '—'}</td>
    </tr>
  </table>`.trim();
}

function buildDashboardLink() {
  return `
  <p style="margin:24px 0 0;">
    <a href="${DASHBOARD_URL}" target="_blank"
       style="display:inline-block;background-color:#1a3c6e;color:#ffffff;font-size:14px;
              font-weight:600;text-decoration:none;padding:12px 24px;border-radius:6px;">
      Log in to Dashboard
    </a>
  </p>`.trim();
}

function buildSignoff() {
  return '<p style="margin:24px 0 0;font-size:14px;color:#374151;">GR8 Lending Corporation</p>';
}

// ---------------------------------------------------------------------------
// Base sender
// ---------------------------------------------------------------------------

async function sendEmail({ to, subject, htmlBody }) {
  try {
    const payload = {
      from: {
        address: process.env.ZEPTO_FROM_EMAIL,
        name: process.env.ZEPTO_FROM_NAME || 'GR8 Lending',
      },
      to: [
        {
          email_address: {
            address: to,
          },
        },
      ],
      subject: subject,
      htmlbody: htmlBody,
    };

    await axios.post(ZEPTOMAIL_API, payload, {
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Zoho-enczapikey ${process.env.ZEPTO_API_TOKEN}`,
      },
    });

    console.log(`[email] Sent "${subject}" → ${to}`);
  } catch (err) {
    const detail = err.response
      ? `status=${err.response.status} body=${JSON.stringify(err.response.data)}`
      : err.message;
    console.error(`[email] Failed to send "${subject}" → ${to}: ${detail}`);
  }
}

// ---------------------------------------------------------------------------
// notifySalesOfficer
// ---------------------------------------------------------------------------

async function notifySalesOfficer(soUser, application) {
  try {
    const subject = `New Lead Assigned: ${application.reference_id}`;

    const body = buildEmailWrapper(`
      <p style="margin:0 0 16px;font-size:14px;color:#374151;">Hi ${soUser.full_name},</p>
      <p style="margin:0 0 8px;font-size:14px;color:#374151;">A new loan application has been assigned to you.</p>
      ${buildAppDetails(application)}
      <p style="margin:0 0 8px;font-size:14px;color:#374151;">Log in to the dashboard to review and process this application.</p>
      ${buildDashboardLink()}
      ${buildSignoff()}
    `);

    await sendEmail({ to: soUser.email, subject, htmlBody: body });
  } catch (err) {
    console.error('[email] notifySalesOfficer error:', err.message);
  }
}

// ---------------------------------------------------------------------------
// notifyTeamByRole
// ---------------------------------------------------------------------------

async function notifyTeamByRole(role, application, context) {
  try {
    const { data: users, error } = await supabase
      .from('admin_users')
      .select('id, email, full_name, roles')
      .contains('roles', [role])
      .eq('is_active', true);

    if (error) {
      console.error('[email] notifyTeamByRole — failed to fetch users:', error.message);
      return;
    }

    if (!users || users.length === 0) {
      console.log(`[email] notifyTeamByRole — no active users with role "${role}"`);
      return;
    }

    // Build role-specific subject and body content
    let subject;
    let greeting;
    let intro;
    let cta;

    switch (role) {
      case 'sales_officer':
        subject = `Unassigned Application: ${application.reference_id}`;
        greeting = 'Hi Team,';
        intro = 'A new application has been submitted without an assigned Sales Officer.';
        cta = 'Please assign this lead immediately.';
        break;

      case 'verifier':
        subject = `New Application for Verification: ${application.reference_id}`;
        greeting = 'Hi Team,';
        intro = 'An application is ready for your verification.';
        cta = 'Log in to the dashboard to proceed.';
        break;

      case 'ci_officer':
        subject = `New Application for CI: ${application.reference_id}`;
        greeting = 'Hi Team,';
        intro = 'An application has passed verification and is ready for Credit Investigation.';
        cta = 'Log in to the CI portal to proceed.';
        break;

      case 'approver':
      case 'admin':
      case 'super_admin':
        subject = `Application Ready for Approval: ${application.reference_id}`;
        greeting = 'Hi Team,';
        intro = 'An application has completed Credit Investigation and is ready for final review.';
        cta = 'Log in to the dashboard to review scores and make a decision.';
        break;

      case 'loan_processing_officer':
        subject = `Application Approved — Ready for Processing: ${application.reference_id}`;
        greeting = 'Hi Team,';
        intro = 'The following application has been approved and is ready for loan processing and fund release.';
        cta = 'Log in to the dashboard to proceed.';
        break;

      default:
        subject = `Application Update: ${application.reference_id}`;
        greeting = 'Hi Team,';
        intro = context.message || 'An application requires your attention.';
        cta = 'Log in to the dashboard to proceed.';
        break;
    }

    for (const user of users) {
      try {
        const body = buildEmailWrapper(`
          <p style="margin:0 0 16px;font-size:14px;color:#374151;">${greeting}</p>
          <p style="margin:0 0 8px;font-size:14px;color:#374151;">${intro}</p>
          ${buildAppDetails(application)}
          <p style="margin:0 0 8px;font-size:14px;color:#374151;">${cta}</p>
          ${buildDashboardLink()}
          ${buildSignoff()}
        `);

        await sendEmail({ to: user.email, subject, htmlBody: body });
      } catch (innerErr) {
        console.error(`[email] notifyTeamByRole — failed for ${user.email}:`, innerErr.message);
      }
    }
  } catch (err) {
    console.error('[email] notifyTeamByRole error:', err.message);
  }
}

// ---------------------------------------------------------------------------
// notifySOReturn
// ---------------------------------------------------------------------------

async function notifySOReturn(soUser, application, returnReason) {
  try {
    const subject = `Application Returned: ${application.reference_id}`;

    const body = buildEmailWrapper(`
      <p style="margin:0 0 16px;font-size:14px;color:#374151;">Hi ${soUser.full_name},</p>
      <p style="margin:0 0 8px;font-size:14px;color:#374151;">The following application has been returned to you for correction or completion.</p>
      ${buildAppDetails(application)}
      <div style="margin:16px 0;padding:16px;background-color:#fef3c7;border-left:4px solid #f59e0b;border-radius:4px;">
        <p style="margin:0;font-size:14px;color:#78350f;"><strong>Return Reason:</strong> ${returnReason || 'No reason provided.'}</p>
      </div>
      <p style="margin:0 0 8px;font-size:14px;color:#374151;">Please coordinate with your client and resubmit the required documents.</p>
      ${buildDashboardLink()}
      ${buildSignoff()}
    `);

    await sendEmail({ to: soUser.email, subject, htmlBody: body });
  } catch (err) {
    console.error('[email] notifySOReturn error:', err.message);
  }
}

// ---------------------------------------------------------------------------
// notifySODecision
// ---------------------------------------------------------------------------

async function notifySODecision(soUser, application, decision) {
  try {
    const isApproved = decision === 'Approved';

    let subject;
    let intro;

    if (isApproved) {
      subject = `Application Approved: ${application.reference_id}`;
      intro = 'The following application has been approved.';
    } else {
      // Determine if declined at verification or final approval based on stage history
      const history = Array.isArray(application.stage_history) ? application.stage_history : [];
      const lastTransition = history.length > 0 ? history[history.length - 1] : null;
      const fromStage = lastTransition ? lastTransition.from : '';

      if (fromStage === 'verifier') {
        subject = `Application Declined at Verification: ${application.reference_id}`;
        intro = 'The following application did not pass the verification stage.';
      } else {
        subject = `Application Declined at Final Approval: ${application.reference_id}`;
        intro = 'The following application did not pass final approval.';
      }
    }

    const body = buildEmailWrapper(`
      <p style="margin:0 0 16px;font-size:14px;color:#374151;">Hi ${soUser.full_name},</p>
      <p style="margin:0 0 8px;font-size:14px;color:#374151;">${intro}</p>
      ${buildAppDetails(application)}
      <p style="margin:0 0 8px;font-size:14px;color:#374151;">
        ${isApproved
          ? 'The application is now moving to loan processing.'
          : 'The application has been marked as Declined. Please inform your client accordingly.'}
      </p>
      ${buildDashboardLink()}
      ${buildSignoff()}
    `);

    await sendEmail({ to: soUser.email, subject, htmlBody: body });
  } catch (err) {
    console.error('[email] notifySODecision error:', err.message);
  }
}

// ---------------------------------------------------------------------------
// sendSOConfirmationRequest
// ---------------------------------------------------------------------------

async function sendSOConfirmationRequest(soUser, application, confirmToken, declineToken) {
  try {
    const BASE_URL = process.env.BASE_URL || 'https://loan-backend-production-cd45.up.railway.app';
    const subject = `Client Confirmation Required: ${application.reference_id}`;

    const confirmUrl = `${BASE_URL}/api/confirm/${confirmToken}`;
    const declineUrl = `${BASE_URL}/api/confirm/${declineToken}`;

    const body = buildEmailWrapper(`
      <p style="margin:0 0 16px;font-size:14px;color:#374151;">Hi ${soUser.full_name},</p>
      <p style="margin:0 0 8px;font-size:14px;color:#374151;">The following application is pending your client's confirmation before final approval. Please coordinate with your client and submit their decision below.</p>
      ${buildAppDetails(application)}
      <div style="margin:24px 0;">
        <p style="margin:0 0 12px;font-size:13px;color:#6b7280;">Select a response below:</p>
        <a href="${confirmUrl}" target="_blank"
           style="display:inline-block;background-color:#065f46;color:#ffffff;font-size:14px;
                  font-weight:600;text-decoration:none;padding:12px 24px;border-radius:6px;
                  margin:0 8px 8px 0;">
          Confirm Proceed
        </a>
        <a href="${declineUrl}" target="_blank"
           style="display:inline-block;background-color:#dc2626;color:#ffffff;font-size:14px;
                  font-weight:600;text-decoration:none;padding:12px 24px;border-radius:6px;
                  margin:0 8px 8px 0;">
          Decline
        </a>
      </div>
      <p style="margin:0 0 8px;font-size:12px;color:#9ca3af;">This link expires in 48 hours and can only be used once.</p>
      ${buildSignoff()}
    `);

    await sendEmail({ to: soUser.email, subject, htmlBody: body });
  } catch (err) {
    console.error('[email] sendSOConfirmationRequest error:', err.message);
  }
}

// ---------------------------------------------------------------------------
// notifyApproverSODecision
// ---------------------------------------------------------------------------

async function notifyApproverSODecision(approverTeam, application, soDecision) {
  try {
    if (!approverTeam || approverTeam.length === 0) {
      console.log('[email] notifyApproverSODecision — empty approver team, skipping');
      return;
    }

    const decisionLabel = soDecision === 'confirm' ? 'Confirmed' : 'Declined';
    const subject = `Client Decision Received: ${application.reference_id}`;

    for (const approver of approverTeam) {
      try {
        const body = buildEmailWrapper(`
          <p style="margin:0 0 16px;font-size:14px;color:#374151;">Hi Team,</p>
          <p style="margin:0 0 8px;font-size:14px;color:#374151;">The Sales Officer has submitted the client's decision for the following application.</p>
          ${buildAppDetails(application)}
          <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:8px 0;">
            <tr>
              <td style="padding:6px 0;font-size:14px;color:#374151;"><strong>Client Decision:</strong> ${decisionLabel}</td>
            </tr>
          </table>
          <p style="margin:0 0 8px;font-size:14px;color:#374151;">Log in to the dashboard to proceed with final approval.</p>
          ${buildDashboardLink()}
          ${buildSignoff()}
        `);

        await sendEmail({ to: approver.email, subject, htmlBody: body });
      } catch (innerErr) {
        console.error(`[email] notifyApproverSODecision — failed for ${approver.email}:`, innerErr.message);
      }
    }
  } catch (err) {
    console.error('[email] notifyApproverSODecision error:', err.message);
  }
}

// ---------------------------------------------------------------------------

module.exports = {
  sendEmail,
  notifySalesOfficer,
  notifyTeamByRole,
  notifySOReturn,
  notifySODecision,
  sendSOConfirmationRequest,
  notifyApproverSODecision,
};
