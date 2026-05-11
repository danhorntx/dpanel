'use strict';
const express   = require('express');
const bcrypt    = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { pool }  = require('../lib/db');
const router    = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, error: 'Too many login attempts. Try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
  // DPanel is accessed directly or behind Apache on loopback — don't trust X-Forwarded-For
  validate: { xForwardedForHeader: false },
});

// ── Brute-force helpers ───────────────────────────────────────────────────────
const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;

async function isLockedOut(ip) {
  try {
    const [[{ cnt }]] = await pool.query(
      `SELECT COUNT(*) AS cnt FROM dpanel_login_attempts
       WHERE ip = ? AND success = 0
         AND created_at > DATE_SUB(NOW(), INTERVAL 15 MINUTE)`,
      [ip]
    );
    return cnt >= LOCKOUT_THRESHOLD;
  } catch (_) { return false; }
}

async function recordAttempt(ip, username, success) {
  try {
    await pool.query(
      'INSERT INTO dpanel_login_attempts (ip, username, success) VALUES (?, ?, ?)',
      [ip, username || null, success ? 1 : 0]
    );
  } catch (_) {}
}

// Promote a verified user record into a session. Shared by both branches
// (no-2FA users finish here from /login; 2FA users finish here from /login/2fa).
async function finalizeLogin(req, user) {
  let domains = null;
  if (user.role !== 'admin') {
    const [rows] = await pool.query(
      'SELECT domain FROM dpanel_user_domains WHERE user_id = ?',
      [user.id]
    );
    domains = rows.map(r => r.domain);
  }
  req.session.userId        = user.id;
  req.session.username      = user.username;
  req.session.role          = user.role;
  req.session.domains       = domains;
  req.session.activeDomain  = domains && domains.length === 1 ? domains[0] : null;
  // Clean up the 2FA challenge state if present
  delete req.session.pendingLoginUserId;
  delete req.session.pendingLoginUsername;

  // ── New-IP alert for admins ────────────────────────────────────────────────
  // First login from a given IP for an admin user triggers an email. We track
  // IPs in dpanel_known_login_ips and rely on PK uniqueness — INSERT IGNORE
  // tells us "was this a new IP?" via affectedRows.
  if (user.role === 'admin' && req.ip) {
    try {
      const [res] = await pool.query(
        'INSERT IGNORE INTO dpanel_known_login_ips (user_id, ip) VALUES (?, ?)',
        [user.id, req.ip]
      );
      const isNewIp = res.affectedRows > 0;
      // Always update last_seen
      await pool.query(
        'UPDATE dpanel_known_login_ips SET last_seen = NOW() WHERE user_id = ? AND ip = ?',
        [user.id, req.ip]
      );
      if (isNewIp) {
        // Fire and forget — never let alerting block the login response
        const notify = require('../lib/notify');
        notify.sendAlert({
          key:     `admin-new-ip:${user.id}:${req.ip}`,
          subject: `[DPanel] New admin login from ${req.ip}`,
          body:    `Admin user "${user.username}" just logged into DPanel from a previously-unseen IP address.\n\n` +
                   `IP: ${req.ip}\n` +
                   `User-Agent: ${req.headers['user-agent'] || '(none)'}\n` +
                   `Time: ${new Date().toISOString()}\n\n` +
                   `If this was you, you can ignore this email. If not, change the password immediately ` +
                   `and revoke any API keys that may be compromised.`,
        }).catch(() => {});
      }
    } catch (_) { /* tracking failure must not block login */ }
  }
}

router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password)
      return res.json({ success: false, error: 'Username and password required' });

    // ── Brute-force lockout check ─────────────────────────────────────────────
    if (await isLockedOut(req.ip)) {
      return res.json({
        success: false,
        error: 'Too many failed login attempts. Try again in 15 minutes.',
        locked: true,
      });
    }

    const [[user]] = await pool.query(
      'SELECT id, username, password_hash, role, totp_enabled FROM dpanel_users WHERE username = ?',
      [username]
    );
    if (!user) {
      await recordAttempt(req.ip, username, false);
      return res.json({ success: false, error: 'Invalid credentials' });
    }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      await recordAttempt(req.ip, username, false);
      return res.json({ success: false, error: 'Invalid credentials' });
    }

    // Password verified. If 2FA is enabled, don't finalize the session yet —
    // stash the user id under a "pending" key and ask the client for the
    // TOTP code via POST /auth/login/2fa.
    if (user.totp_enabled) {
      req.session.pendingLoginUserId   = user.id;
      req.session.pendingLoginUsername = user.username;
      return res.json({ success: false, requires2fa: true });
    }

    // No 2FA — finalize and record success
    await recordAttempt(req.ip, username, true);
    await finalizeLogin(req, user);
    res.json({ success: true, role: user.role, username: user.username });
  } catch (err) {
    console.error('[auth] login error:', err.message);
    res.json({ success: false, error: 'Internal error' });
  }
});

// Second step of 2FA-enabled login. Reads the pending user from the session
// (stamped by /login above), verifies the TOTP, finalizes the session.
router.post('/login/2fa', loginLimiter, async (req, res) => {
  try {
    if (await isLockedOut(req.ip)) {
      return res.json({ success: false, error: 'Too many failed login attempts. Try again in 15 minutes.', locked: true });
    }
    const pendingId = req.session.pendingLoginUserId;
    const pendingUn = req.session.pendingLoginUsername;
    if (!pendingId) return res.json({ success: false, error: 'No login in progress. Sign in again.' });

    const { token } = req.body;
    const [[user]] = await pool.query(
      'SELECT id, username, role, totp_secret, totp_enabled FROM dpanel_users WHERE id = ?',
      [pendingId]
    );
    if (!user || !user.totp_enabled || !user.totp_secret) {
      delete req.session.pendingLoginUserId;
      delete req.session.pendingLoginUsername;
      return res.json({ success: false, error: 'Invalid login state. Sign in again.' });
    }

    const totp = require('../lib/totp');
    if (!totp.verify(user.totp_secret, token)) {
      await recordAttempt(req.ip, pendingUn, false);
      return res.json({ success: false, error: 'Invalid 2FA code.' });
    }

    await recordAttempt(req.ip, pendingUn, true);
    await finalizeLogin(req, user);
    res.json({ success: true, role: user.role, username: user.username });
  } catch (err) {
    console.error('[auth] 2fa-login error:', err.message);
    res.json({ success: false, error: 'Internal error' });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

// ── Whoami — lets the frontend know current user state ────────────────────────
router.get('/me', (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.json({ success: false, error: 'Not authenticated' });
  }
  res.json({
    success:       true,
    userId:        req.session.userId,
    username:      req.session.username,
    role:          req.session.role,
    domains:       req.session.domains,
    activeDomain:  req.session.activeDomain,
  });
});

// ── Set active domain context ─────────────────────────────────────────────────
router.post('/active-domain', (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ success: false, error: 'Not authenticated' });
  }
  const { domain } = req.body;
  if (!domain) {
    req.session.activeDomain = null;
    return res.json({ success: true, activeDomain: null });
  }
  // Scoped users can only switch to their own domains
  if (req.session.role !== 'admin' && req.session.domains && !req.session.domains.includes(domain)) {
    return res.status(403).json({ success: false, error: 'Domain not assigned to your account' });
  }
  req.session.activeDomain = domain;
  res.json({ success: true, activeDomain: domain });
});

module.exports = router;
