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

module.exports = router;
