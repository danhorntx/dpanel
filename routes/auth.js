'use strict';
const express = require('express');
const bcrypt  = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');
const router = express.Router();

const CONFIG_FILE = path.join(__dirname, '..', 'config.json');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { success: false, error: 'Too many login attempts. Try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.json({ success: false, error: 'Username and password required' });
    if (!fs.existsSync(CONFIG_FILE)) return res.json({ success: false, error: 'Panel not configured. Run setup.js first.' });
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (username !== config.username) return res.json({ success: false, error: 'Invalid credentials' });
    const match = await bcrypt.compare(password, config.passwordHash);
    if (!match) return res.json({ success: false, error: 'Invalid credentials' });
    req.session.authenticated = true;
    req.session.username = username;
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

module.exports = router;
