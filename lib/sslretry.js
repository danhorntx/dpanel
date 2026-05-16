'use strict';
/**
 * lib/sslretry.js — SSL issuance retry policy.
 *
 * When initial certbot fails (DNS not propagated, ACME rate-limit, etc.)
 * we don't bail — we record the attempt and let a cron pick the domain
 * back up at H+1, H+5, H+13, H+25 (cumulative offsets from the first
 * attempt; ~1h, 6h, 19h, 44h gaps would be too slow, so spec uses
 * cumulative). After 5 unsuccessful attempts we give up and surface the
 * failure to the operator.
 *
 * Tables:
 *   dpanel_ssl_attempts        — log of every attempt
 *   dpanel_domain_settings     — per-domain retry state
 */

const { pool, audit } = require('./db');
const ssl = require('./ssl');

// Cumulative offsets in HOURS from first attempt where a retry should fire.
// [1, 5, 13, 25] gives intervals of {1h, 4h, 8h, 12h}.
const RETRY_OFFSETS_H = [1, 5, 13, 25];
const MAX_ATTEMPTS    = 1 + RETRY_OFFSETS_H.length; // 5 total

/**
 * Record a single certbot attempt outcome.
 * @returns {number} attempt_no for this (domain, host).
 */
async function recordAttempt(domain, host, success, errorMsg) {
  const [[row]] = await pool.query(
    'SELECT COUNT(*) AS n FROM dpanel_ssl_attempts WHERE domain = ? AND host = ?',
    [domain, host]
  );
  const attemptNo = row.n + 1;
  await pool.query(
    `INSERT INTO dpanel_ssl_attempts (domain, host, attempt_no, success, error_msg)
     VALUES (?, ?, ?, ?, ?)`,
    [domain, host, attemptNo, success ? 1 : 0, errorMsg ? String(errorMsg).slice(0, 2000) : null]
  );
  return attemptNo;
}

/**
 * Decide the rollup state for a domain across all its hosts and persist it
 * onto dpanel_domain_settings.
 *
 * Rules:
 *   - 'active'  — every host that's been attempted has at least one success.
 *   - 'failed'  — any host has reached MAX_ATTEMPTS without success.
 *   - 'pending' — otherwise (retries still due).
 */
async function refreshDomainState(domain) {
  const [hosts] = await pool.query(
    `SELECT host,
            MAX(success) AS any_success,
            MAX(attempt_no) AS attempts,
            MAX(attempted_at) AS last_at
     FROM dpanel_ssl_attempts WHERE domain = ?
     GROUP BY host`,
    [domain]
  );
  if (!hosts.length) return null;

  let state = 'active';
  let lastAt = null;
  for (const h of hosts) {
    if (!lastAt || h.last_at > lastAt) lastAt = h.last_at;
    if (h.any_success) continue;
    if (h.attempts >= MAX_ATTEMPTS) { state = 'failed'; break; }
    state = 'pending';
  }

  await pool.query(
    `INSERT INTO dpanel_domain_settings (domain, ssl_retry_state, ssl_last_attempt_at)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE
       ssl_retry_state = VALUES(ssl_retry_state),
       ssl_last_attempt_at = VALUES(ssl_last_attempt_at)`,
    [domain, state, lastAt]
  );
  return state;
}

/**
 * Wrap a certbot call so we record attempts + update state automatically.
 * Re-throws the original error so callers can decide whether to surface it.
 *
 * @param {string}   domain
 * @param {string}   host
 * @param {function} certbotFn  async () => result
 */
async function recordedAttempt(domain, host, certbotFn) {
  try {
    const result = await certbotFn();
    await recordAttempt(domain, host, true, null);
    await refreshDomainState(domain);
    return result;
  } catch (err) {
    await recordAttempt(domain, host, false, err.message);
    await refreshDomainState(domain);
    throw err;
  }
}

/**
 * Iterate every domain that has at least one host still in retry-pending state
 * and re-attempt those hosts whose retry window has come due.
 *
 * Called by a cron (every 15 min) from server.js.
 */
async function runDueRetries() {
  const [pending] = await pool.query(
    `SELECT domain FROM dpanel_domain_settings WHERE ssl_retry_state = 'pending'`
  );
  const adminEmail = await _adminEmail();
  let retried = 0;

  for (const { domain } of pending) {
    const [hosts] = await pool.query(
      `SELECT host,
              MAX(success) AS any_success,
              MAX(attempt_no) AS attempts,
              MIN(attempted_at) AS first_at,
              MAX(attempted_at) AS last_at
       FROM dpanel_ssl_attempts WHERE domain = ?
       GROUP BY host`,
      [domain]
    );

    for (const h of hosts) {
      if (h.any_success) continue;
      if (h.attempts >= MAX_ATTEMPTS) continue;

      const offsetH = RETRY_OFFSETS_H[h.attempts - 1];
      if (offsetH === undefined) continue;
      const dueAt = new Date(new Date(h.first_at).getTime() + offsetH * 3600 * 1000);
      if (Date.now() < dueAt.getTime()) continue;

      // Choose the right certbot path based on the host shape.
      const fn = _chooseCertbotFn(domain, h.host, adminEmail);
      if (!fn) continue;

      try {
        await recordedAttempt(domain, h.host, fn);
        audit(null, 'cron', 'ssl:retry-success', h.host, `attempt=${h.attempts + 1}`);
      } catch (err) {
        audit(null, 'cron', 'ssl:retry-fail', h.host, `attempt=${h.attempts + 1} err=${err.message.slice(0, 200)}`);
      }
      retried++;
    }
  }
  return { domains: pending.length, retried };
}

function _chooseCertbotFn(domain, host, email) {
  // mail.* and mta-sts.*  → certonly --webroot (no Apache vhost for mail.*)
  // everything else       → certbot --apache (we own a vhost)
  if (host === `mail.${domain}`) {
    return () => ssl.issueWebrootCert(host, email);
  }
  return () => ssl.autoSSL(host, email);
}

async function _adminEmail() {
  try {
    const users = require('./users');
    return (await users.getAdminEmail()) || 'admin@localhost';
  } catch (_) { return 'admin@localhost'; }
}

/**
 * Public: list a domain's SSL state for the Access tab UI.
 *   { state, hosts: [{ host, attempts, lastAttemptAt, lastError, success }] }
 */
async function statusFor(domain) {
  const [[settings]] = await pool.query(
    `SELECT ssl_retry_state, ssl_last_attempt_at
     FROM dpanel_domain_settings WHERE domain = ?`,
    [domain]
  );
  const [hosts] = await pool.query(
    `SELECT host,
            MAX(success) AS success,
            MAX(attempt_no) AS attempts,
            MAX(attempted_at) AS last_at,
            SUBSTRING_INDEX(GROUP_CONCAT(error_msg ORDER BY attempted_at DESC SEPARATOR '||'), '||', 1) AS last_error
     FROM dpanel_ssl_attempts WHERE domain = ?
     GROUP BY host
     ORDER BY host`,
    [domain]
  );
  return {
    state: settings?.ssl_retry_state || null,
    lastAttemptAt: settings?.ssl_last_attempt_at || null,
    hosts: hosts.map(h => ({
      host: h.host,
      attempts: h.attempts,
      lastAttemptAt: h.last_at,
      success: !!h.success,
      lastError: h.success ? null : h.last_error,
      retriesRemaining: Math.max(0, MAX_ATTEMPTS - h.attempts),
    })),
  };
}

/**
 * Operator-triggered immediate retry — same as the cron path but for one
 * specific (domain, host). Used by the "Retry SSL" button on the Access tab.
 */
async function retryNow(domain, host, opts = {}) {
  const adminEmail = await _adminEmail();
  const fn = _chooseCertbotFn(domain, host, adminEmail);
  if (!fn) throw new Error(`No retry handler for host ${host}.`);
  await recordedAttempt(domain, host, fn);
  audit(opts.actorId || null, null, 'ssl:retry-manual', host, domain);
}

module.exports = {
  RETRY_OFFSETS_H,
  MAX_ATTEMPTS,
  recordAttempt,
  recordedAttempt,
  refreshDomainState,
  runDueRetries,
  statusFor,
  retryNow,
};
