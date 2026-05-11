'use strict';
/**
 * lib/notify.js — Email alerts for operator-relevant events.
 *
 * Pipes through the local Postfix on 127.0.0.1:25 so DKIM signing /
 * SPF / etc. all apply automatically. Logs every send (or dedupe-skip)
 * to `dpanel_notifications` for trending + the Settings UI to display.
 *
 * Dedupe: an alert with the same `key` won't send twice within the
 * configurable window (default 24h). The second attempt logs as
 * status='suppressed' so it shows up in the UI but doesn't spam.
 *
 * Recipient: defaults to the admin email from users.getAdminEmail().
 * If none is set, the alert is logged as 'failed' with a clear reason
 * — we don't fall back to a bogus address.
 */

const nodemailer  = require('nodemailer');
const { execSync } = require('child_process');
const { pool }    = require('./db');
const users       = require('./users');

const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;
let _myHostname = null;

function _hostname() {
  if (_myHostname) return _myHostname;
  try { _myHostname = execSync('hostname -f', { encoding: 'utf8', timeout: 2000 }).trim(); }
  catch (_) { _myHostname = 'localhost'; }
  return _myHostname;
}

async function _logNotification({ alert_key, subject, body, recipient, status, error }) {
  try {
    await pool.query(
      'INSERT INTO dpanel_notifications (alert_key, subject, body, recipient, status, error) VALUES (?, ?, ?, ?, ?, ?)',
      [alert_key, subject, body || null, recipient || null, status, error || null]
    );
  } catch (_) { /* never let logging block sending */ }
}

/**
 * Has an alert with this key been sent successfully within the dedupe window?
 */
async function _isDeduped(alertKey) {
  try {
    const [[row]] = await pool.query(
      `SELECT id FROM dpanel_notifications
        WHERE alert_key = ? AND status = 'sent'
          AND sent_at > DATE_SUB(NOW(), INTERVAL ? SECOND)
        LIMIT 1`,
      [alertKey, Math.floor(DEDUPE_WINDOW_MS / 1000)]
    );
    return !!row;
  } catch (_) { return false; }
}

/**
 * Send an alert. Returns a status object — caller may inspect but shouldn't
 * gate behavior on it. Send failures are logged + non-throwing by design.
 *
 * @param {object} opts
 * @param {string} opts.key       — dedupe key, e.g. "ssl-expiry:foo.com"
 * @param {string} opts.subject   — email subject line
 * @param {string} opts.body      — email body (plain text)
 * @param {string} [opts.recipient] — override recipient; defaults to admin email
 * @param {boolean} [opts.html]   — body is HTML (default plain)
 * @param {boolean} [opts.bypassDedupe] — for manual/test sends
 */
async function sendAlert({ key, subject, body, recipient, html = false, bypassDedupe = false }) {
  if (!key || !subject) throw new Error('sendAlert requires key + subject');

  const to = recipient || await users.getAdminEmail();
  if (!to) {
    await _logNotification({ alert_key: key, subject, body, recipient: null, status: 'failed', error: 'No admin email configured' });
    return { sent: false, reason: 'no-recipient' };
  }

  if (!bypassDedupe && await _isDeduped(key)) {
    await _logNotification({ alert_key: key, subject, body, recipient: to, status: 'suppressed', error: null });
    return { sent: false, reason: 'deduped' };
  }

  const transporter = nodemailer.createTransport({
    host:   '127.0.0.1',
    port:   25,
    secure: false,
    tls:    { rejectUnauthorized: false },
  });

  const from = `DPanel <noreply@${_hostname()}>`;
  try {
    await transporter.sendMail({
      from, to, subject,
      [html ? 'html' : 'text']: body,
    });
    await _logNotification({ alert_key: key, subject, body, recipient: to, status: 'sent', error: null });
    return { sent: true };
  } catch (err) {
    await _logNotification({ alert_key: key, subject, body, recipient: to, status: 'failed', error: err.message });
    return { sent: false, reason: 'send-error', error: err.message };
  }
}

/**
 * Recent notification history for the UI. Newest first.
 */
async function recentAlerts(limit = 50) {
  const cap = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
  const [rows] = await pool.query(
    'SELECT id, alert_key, subject, recipient, status, error, sent_at FROM dpanel_notifications ORDER BY sent_at DESC LIMIT ?',
    [cap]
  );
  return rows;
}

module.exports = { sendAlert, recentAlerts };
