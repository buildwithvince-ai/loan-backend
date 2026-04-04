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

function buildInfoRow(label, value) {
  return `
  <tr>
    <td style="padding:6px 0;font-size:13px;color:#6b7280;width:160px;vertical-align:top;">${label}</td>
    <td style="padding:6px 0;font-size:13px;color:#111827;font-weight:600;vertical-align:top;">${value || '—'}</td>
  </tr>`.trim();
}

function buildApplicationSummaryTable(application) {
  const rows = [
    buildInfoRow('Reference ID', application.reference_id),
    buildInfoRow('Applicant Name', application.full_name),
    buildInfoRow('Loan Type', application.loan_type),
    buildInfoRow('Loan Amount', application.loan_amount ? `PHP ${Number(application.loan_amount).toLocaleString('en-PH')}` : null),
    buildInfoRow('Phone', application.phone),
  ].join('');

  return `
  <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin-top:8px;">
    ${rows}
  </table>`.trim();
}

function buildCTAButton(label, url, bgColor) {
  const color = bgColor || '#1a3c6e';
  return `
  <a href="${url}" target="_blank"
     style="display:inline-block;background-color:${color};color:#ffffff;font-size:14px;
            font-weight:600;text-decoration:none;padding:12px 24px;border-radius:6px;
            margin:8px 8px 8px 0;">
    ${label}
  </a>`.trim();
}

function buildDashboardLink() {
  return `
  <p style="margin:24px 0 0;">
    <a href="${DASHBOARD_URL}" target="_blank"
       style="font-size:13px;color:#1a3c6e;text-decoration:underline;">
      View in Dashboard
    </a>
  </p>`.trim();
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
        Authorization: `Zoho-enczapikey ${process.env.ZEPTO_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });

    console.log(`[email] Sent "${subject}" → ${to}`);
  } catch (err) {
    const detail = err.response ? JSON.stringify(err.response.data) : err.message;
    console.error(`[email] Failed to send "${subject}" → ${to}: ${detail}`);
  }
}

// ---------------------------------------------------------------------------
// notifySalesOfficer
// ---------------------------------------------------------------------------

async function notifySalesOfficer(soUser, application) {
  try {
    const subject = `New Application Assigned: ${application.reference_id}`;

    const body = buildEmailWrapper(`
      <h2 style="margin:0 0 8px;font-size:18px;color:#111827;">New Application Assigned</h2>
      <p style="margin:0 0 20px;font-size:14px;color:#6b7280;">
        A new loan application has been assigned to you for review.
      </p>
      ${buildApplicationSummaryTable(application)}
      ${buildDashboardLink()}
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
      .select('id, email, full_name, role')
      .eq('role', role)
      .eq('is_active', true);

    if (error) {
      console.error('[email] notifyTeamByRole — failed to fetch users:', error.message);
      return;
    }

    if (!users || users.length === 0) {
      console.log(`[email] notifyTeamByRole — no active users with role "${role}"`);
      return;
    }

    const subject = `Application Update: ${application.reference_id}`;

    for (const user of users) {
      try {
        const body = buildEmailWrapper(`
          <h2 style="margin:0 0 8px;font-size:18px;color:#111827;">Application Update</h2>
          <p style="margin:0 0 20px;font-size:14px;color:#374151;">${context.message || 'An application requires your attention.'}</p>
          ${buildApplicationSummaryTable(application)}
          ${buildDashboardLink()}
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
      <h2 style="margin:0 0 8px;font-size:18px;color:#b45309;">Application Returned</h2>
      <p style="margin:0 0 20px;font-size:14px;color:#6b7280;">
        The following application has been returned to you for action.
      </p>
      ${buildApplicationSummaryTable(application)}
      <div style="margin-top:20px;padding:16px;background-color:#fef3c7;border-left:4px solid #f59e0b;border-radius:4px;">
        <p style="margin:0 0 4px;font-size:12px;font-weight:700;color:#92400e;text-transform:uppercase;letter-spacing:0.5px;">Return Reason</p>
        <p style="margin:0;font-size:14px;color:#78350f;">${returnReason || 'No reason provided.'}</p>
      </div>
      ${buildDashboardLink()}
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
    const subject = `Application ${decision}: ${application.reference_id}`;
    const headerColor = isApproved ? '#065f46' : '#991b1b';
    const badgeBg = isApproved ? '#d1fae5' : '#fee2e2';
    const badgeColor = isApproved ? '#065f46' : '#991b1b';

    const body = buildEmailWrapper(`
      <h2 style="margin:0 0 8px;font-size:18px;color:${headerColor};">Application ${decision}</h2>
      <p style="margin:0 0 20px;font-size:14px;color:#6b7280;">
        A final decision has been recorded for the following application.
      </p>
      ${buildApplicationSummaryTable(application)}
      <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin-top:8px;">
        ${buildInfoRow('Final Score', application.final_score != null ? application.final_score.toFixed(2) : null)}
        ${buildInfoRow('Tier', application.tier)}
        ${buildInfoRow('Decision',
          `<span style="display:inline-block;padding:2px 10px;border-radius:12px;font-size:12px;
                        font-weight:700;background-color:${badgeBg};color:${badgeColor};">
            ${decision}
          </span>`
        )}
      </table>
      ${buildDashboardLink()}
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

    const tierBRow = application.tier === 'tier_b' && application.ci_recommended_amount
      ? buildInfoRow(
          'CI Recommended Amt',
          `PHP ${Number(application.ci_recommended_amount).toLocaleString('en-PH')}`
        )
      : '';

    const body = buildEmailWrapper(`
      <h2 style="margin:0 0 8px;font-size:18px;color:#1a3c6e;">Client Confirmation Required</h2>
      <p style="margin:0 0 20px;font-size:14px;color:#6b7280;">
        Please review the application summary below and confirm or decline the client's intent to proceed.
        This link expires in <strong>48 hours</strong> and can only be used once.
      </p>

      <h3 style="margin:0 0 10px;font-size:14px;font-weight:700;color:#374151;text-transform:uppercase;
                 letter-spacing:0.5px;">Application Summary</h3>
      <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;">
        ${buildInfoRow('Reference ID', application.reference_id)}
        ${buildInfoRow('Applicant Name', application.full_name)}
        ${buildInfoRow('Phone', application.phone)}
        ${buildInfoRow('Loan Type', application.loan_type)}
        ${buildInfoRow('Loan Amount', application.loan_amount ? `PHP ${Number(application.loan_amount).toLocaleString('en-PH')}` : null)}
        ${buildInfoRow('Loan Term', application.loan_term ? `${application.loan_term} months` : null)}
        ${buildInfoRow('Final Score', application.final_score != null ? application.final_score.toFixed(2) : null)}
        ${buildInfoRow('Tier', application.tier)}
        ${tierBRow}
      </table>

      <div style="margin-top:28px;">
        <p style="margin:0 0 12px;font-size:13px;color:#6b7280;">Select a response below:</p>
        ${buildCTAButton('Confirm Proceed', confirmUrl, '#065f46')}
        ${buildCTAButton('Decline', declineUrl, '#dc2626')}
      </div>

      <p style="margin:20px 0 0;font-size:12px;color:#9ca3af;">
        These are single-use links. Once clicked, they cannot be used again.
      </p>
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
    const subject = `SO Response Received: ${application.reference_id}`;

    const badgeBg = soDecision === 'confirm' ? '#d1fae5' : '#fee2e2';
    const badgeColor = soDecision === 'confirm' ? '#065f46' : '#991b1b';
    const now = new Date().toISOString();

    for (const approver of approverTeam) {
      try {
        const body = buildEmailWrapper(`
          <h2 style="margin:0 0 8px;font-size:18px;color:#1a3c6e;">SO Response Received</h2>
          <p style="margin:0 0 20px;font-size:14px;color:#6b7280;">
            The Sales Officer has responded to the confirmation request for this application.
          </p>
          ${buildApplicationSummaryTable(application)}
          <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin-top:8px;">
            ${buildInfoRow('Sales Officer', application.assigned_sales_officer_name || 'N/A')}
            ${buildInfoRow('SO Decision',
              `<span style="display:inline-block;padding:2px 10px;border-radius:12px;font-size:12px;
                            font-weight:700;background-color:${badgeBg};color:${badgeColor};">
                ${decisionLabel}
              </span>`
            )}
            ${buildInfoRow('Responded At', now)}
          </table>
          ${buildDashboardLink()}
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
