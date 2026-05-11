'use strict';
const express  = require('express');
const bcrypt   = require('bcryptjs');
const { pool, audit } = require('../lib/db');
const router   = express.Router();

// GET server info (IP, hostname) for the DNS helper
router.get('/server-info', (req, res) => {
  const { execSync } = require('child_process');
  try {
    const ip       = execSync("curl -s -4 ifconfig.me", { encoding: 'utf8', timeout: 5000 }).trim();
    const hostname = execSync("hostname -f", { encoding: 'utf8' }).trim();
    res.json({ success: true, data: { ip, hostname } });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// PUT /api/settings/password — change password for the currently logged-in user
router.put('/password', async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword)
      return res.json({ success: false, error: 'Both current and new password are required.' });
    if (newPassword.length < 8)
      return res.json({ success: false, error: 'New password must be at least 8 characters.' });

    const userId = req.session.userId;
    if (!userId) return res.status(401).json({ success: false, error: 'Not authenticated.' });

    // Load current hash from DB
    const [[user]] = await pool.query(
      'SELECT id, username, password_hash FROM dpanel_users WHERE id = ?',
      [userId]
    );
    if (!user) return res.json({ success: false, error: 'User not found.' });

    const match = await bcrypt.compare(currentPassword, user.password_hash);
    if (!match) return res.json({ success: false, error: 'Current password is incorrect.' });

    const newHash = await bcrypt.hash(newPassword, 12);
    await pool.query(
      'UPDATE dpanel_users SET password_hash = ? WHERE id = ?',
      [newHash, userId]
    );

    await audit(userId, user.username, 'settings:change-password', null, null, req.ip);

    // Destroy session — user must log in again with new password
    req.session.destroy(() => {});
    res.json({ success: true });
  } catch (err) {
    console.error('[settings] password change error:', err.message);
    res.json({ success: false, error: 'Internal error.' });
  }
});

// GET /api/settings/me — return current user's profile (timezone, username, email, role)
router.get('/me', async (req, res) => {
  try {
    const userId = req.session.userId;
    if (!userId) return res.status(401).json({ success: false, error: 'Not authenticated.' });
    const [[user]] = await pool.query(
      `SELECT id, username, email, role, timezone, created_at FROM dpanel_users WHERE id = ?`,
      [userId]
    );
    if (!user) return res.json({ success: false, error: 'User not found.' });
    res.json({ success: true, data: user });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ── 2FA (TOTP) ────────────────────────────────────────────────────────────────
const totp = require('../lib/totp');
let qrcode; try { qrcode = require('qrcode'); } catch (_) { /* lazy — missing dep is reported per-request */ }

// GET /api/settings/2fa/status — { enabled }
router.get('/2fa/status', async (req, res) => {
  try {
    const userId = req.session.userId;
    if (!userId) return res.status(401).json({ success: false, error: 'Not authenticated.' });
    const [[user]] = await pool.query('SELECT totp_enabled FROM dpanel_users WHERE id = ?', [userId]);
    res.json({ success: true, data: { enabled: !!user?.totp_enabled } });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// POST /api/settings/2fa/setup — generates a NEW secret + QR image, stashes
// the secret on the session under a temp key. Calling this does NOT enable
// 2FA — the user must verify a code first via /verify.
router.post('/2fa/setup', async (req, res) => {
  try {
    const userId = req.session.userId;
    if (!userId) return res.status(401).json({ success: false, error: 'Not authenticated.' });
    if (!qrcode) return res.json({ success: false, error: 'qrcode module not installed — run `npm install` on the server.' });

    const [[user]] = await pool.query('SELECT username, totp_enabled FROM dpanel_users WHERE id = ?', [userId]);
    if (!user) return res.json({ success: false, error: 'User not found.' });
    if (user.totp_enabled) return res.json({ success: false, error: '2FA is already enabled. Disable it first to re-enroll.' });

    const secret = totp.generateSecret();
    const label  = `${user.username}@${req.hostname || 'dpanel'}`;
    const uri    = totp.generateUri(secret, label, 'DPanel');
    const qrSvg  = await qrcode.toString(uri, { type: 'svg', margin: 1, color: { dark: '#e4e8f0', light: '#00000000' } });

    // Stash on session — not in DB. If the user never verifies, no DB write.
    req.session.totp_setup_secret = secret;

    res.json({ success: true, data: { secret, uri, qrSvg } });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// POST /api/settings/2fa/verify — body { token } — verifies the TOTP against
// the in-flight secret and, on success, writes it to the DB + flips totp_enabled.
router.post('/2fa/verify', async (req, res) => {
  try {
    const userId = req.session.userId;
    if (!userId) return res.status(401).json({ success: false, error: 'Not authenticated.' });
    const secret = req.session.totp_setup_secret;
    if (!secret) return res.json({ success: false, error: 'No 2FA setup in progress — start over.' });

    const { token } = req.body;
    if (!totp.verify(secret, token)) return res.json({ success: false, error: 'Invalid code. Try again.' });

    await pool.query('UPDATE dpanel_users SET totp_secret = ?, totp_enabled = 1 WHERE id = ?', [secret, userId]);
    delete req.session.totp_setup_secret;
    await audit(userId, req.session.username, 'settings:enable-2fa', null, null, req.ip);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// DELETE /api/settings/2fa — body { password } — disables 2FA. Requires
// the current password as a sanity check so a stolen session can't quietly
// turn off the second factor.
router.delete('/2fa', async (req, res) => {
  try {
    const userId = req.session.userId;
    if (!userId) return res.status(401).json({ success: false, error: 'Not authenticated.' });
    const { password } = req.body;
    if (!password) return res.json({ success: false, error: 'Password required to disable 2FA.' });

    const [[user]] = await pool.query('SELECT password_hash FROM dpanel_users WHERE id = ?', [userId]);
    if (!user) return res.json({ success: false, error: 'User not found.' });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.json({ success: false, error: 'Password incorrect.' });

    await pool.query('UPDATE dpanel_users SET totp_secret = NULL, totp_enabled = 0 WHERE id = ?', [userId]);
    await audit(userId, req.session.username, 'settings:disable-2fa', null, null, req.ip);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// PATCH /api/settings/email — set the current user's contact email.
// For admins, this becomes the panel's canonical address (Let's Encrypt, alerts).
router.patch('/email', async (req, res) => {
  try {
    const userId = req.session.userId;
    if (!userId) return res.status(401).json({ success: false, error: 'Not authenticated.' });

    const users = require('../lib/users');
    const { email } = req.body;
    // Pass through users.updateUser for validation + audit consistency
    await users.updateUser(userId, { email });
    await audit(userId, req.session.username, 'settings:change-email', null, email || '(cleared)', req.ip);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// PATCH /api/settings/timezone — update current user's analytics timezone preference
router.patch('/timezone', async (req, res) => {
  try {
    const userId = req.session.userId;
    if (!userId) return res.status(401).json({ success: false, error: 'Not authenticated.' });

    const { timezone } = req.body;
    if (!timezone) return res.json({ success: false, error: 'timezone is required' });

    // Validate timezone string
    try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }); }
    catch { return res.json({ success: false, error: 'Invalid timezone' }); }

    await pool.query('UPDATE dpanel_users SET timezone = ? WHERE id = ?', [timezone, userId]);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// GET /api/settings/notifications/recent — recent alert history for the UI.
router.get('/notifications/recent', async (req, res) => {
  try {
    if (!req.session.userId) return res.status(401).json({ success: false, error: 'Not authenticated.' });
    const notify = require('../lib/notify');
    res.json({ success: true, data: await notify.recentAlerts(50) });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// POST /api/settings/notifications/test — send a test alert to confirm
// SMTP works + the admin email field is real.
router.post('/notifications/test', async (req, res) => {
  try {
    if (!req.session.userId) return res.status(401).json({ success: false, error: 'Not authenticated.' });
    const notify = require('../lib/notify');
    const result = await notify.sendAlert({
      key:          `test:${Date.now()}`,
      subject:      '[DPanel] Test notification',
      body:         'If you got this, alerts from this DPanel install can reach your inbox. ' +
                    'Sent manually from Settings → Notifications.',
      bypassDedupe: true,
    });
    res.json({ success: result.sent, data: result });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

module.exports = router;
