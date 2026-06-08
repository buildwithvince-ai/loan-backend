'use strict';

const crypto = require('crypto');
const { supabase } = require('./supabase');

/**
 * generateConfirmationTokens
 *
 * Creates one 'confirm' token and one 'decline' token in the
 * confirmation_tokens table for the given applicationId.
 * Both expire in 48 hours.
 *
 * @param {string} applicationId - UUID of the application
 * @returns {{ confirmToken: string, declineToken: string }}
 */
async function generateConfirmationTokens(applicationId) {
  const confirmToken = crypto.randomBytes(32).toString('hex');
  const declineToken = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

  const rows = [
    {
      token: confirmToken,
      application_id: applicationId,
      action: 'confirm',
      used: false,
      expires_at: expiresAt,
    },
    {
      token: declineToken,
      application_id: applicationId,
      action: 'decline',
      used: false,
      expires_at: expiresAt,
    },
  ];

  const { error } = await supabase.from('confirmation_tokens').insert(rows);

  if (error) {
    throw new Error(`[tokens] Failed to insert confirmation tokens: ${error.message}`);
  }

  console.log(`[tokens] Generated confirm/decline tokens for application ${applicationId}`);

  return { confirmToken, declineToken };
}

/**
 * validateToken
 *
 * Looks up a token in confirmation_tokens and checks its validity.
 *
 * @param {string} token - The raw hex token string
 * @returns {{ valid: true, action: string, application_id: string }
 *          |{ valid: false, reason: string }}
 */
async function validateToken(token) {
  const { data, error } = await supabase
    .from('confirmation_tokens')
    .select('id, token, application_id, action, used, expires_at')
    .eq('token', token)
    .maybeSingle();

  if (error) {
    console.error('[tokens] validateToken query error:', error.message);
    return { valid: false, reason: 'Token not found' };
  }

  if (!data) {
    return { valid: false, reason: 'Token not found' };
  }

  if (data.used) {
    return { valid: false, reason: 'Token has already been used' };
  }

  if (new Date(data.expires_at) < new Date()) {
    return { valid: false, reason: 'Token has expired' };
  }

  return {
    valid: true,
    action: data.action,
    application_id: data.application_id,
  };
}

/**
 * consumeToken
 *
 * Atomically marks a token used, but ONLY if it is currently unused (H8).
 * The `used=false` precondition + returning rows makes this a compare-and-swap:
 * exactly one of N concurrent requests gets a row back; the rest get none and
 * must not proceed. Prevents token replay (e.g. a link prefetcher firing the
 * URL twice → duplicate so_decision writes + duplicate approver emails).
 *
 * @param {string} token - The raw hex token string
 * @returns {Promise<boolean>} true if THIS call consumed the token, false if it
 *   was already used / not found (caller must treat false as invalid).
 */
async function consumeToken(token) {
  const { data, error } = await supabase
    .from('confirmation_tokens')
    .update({ used: true })
    .eq('token', token)
    .eq('used', false)
    .select('id');

  if (error) {
    console.error('[tokens] consumeToken error:', error.message);
    throw new Error(`[tokens] Failed to consume token: ${error.message}`);
  }

  const won = Array.isArray(data) && data.length > 0;
  if (won) {
    console.log(`[tokens] Consumed token: ${token.substring(0, 8)}...`);
  } else {
    console.log(`[tokens] Token already consumed (replay blocked): ${token.substring(0, 8)}...`);
  }
  return won;
}

module.exports = { generateConfirmationTokens, validateToken, consumeToken };
