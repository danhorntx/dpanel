'use strict';
const express  = require('express');
const bcrypt   = require('bcryptjs');
const fs       = require('fs');
const path     = require('path');
const router   = express.Router();

const CONFIG_FILE = path.join(__dirname, '..', 'config.json');

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

// PUT change admin password
router.put('/password', async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword)
      return res.json({ success: false, error: 'Both current and new password are required.' });
    if (newPassword.length < 8)
      return res.json({ success: false, error: 'New password must be at least 8 characters.' });

    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    const match  = await bcrypt.compare(currentPassword, config.passwordHash);
    if (!match) return res.json({ success: false, error: 'Current password is incorrect.' });

    config.passwordHash = await bcrypt.hash(newPassword, 12);
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    require('child_process').execSync(`chmod 600 ${CONFIG_FILE}`);

    // Destroy session so they have to log in with new password
    req.session.destroy(() => {});
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

module.exports = router;
