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

router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password)
      return res.json({ success: false, error: 'Username and password required' });

    const [[user]] = await pool.query(
      'SELECT id, username, password_hash, role FROM dpanel_users WHERE username = ?',
      [username]
    );
    if (!user)
      return res.json({ success: false, error: 'Invalid credentials' });

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match)
      return res.json({ success: false, error: 'Invalid credentials' });

    // Load domain assignments for scoped users
    let domains = null;
    if (user.role !== 'admin') {
      const [rows] = await pool.query(
        'SELECT domain FROM dpanel_user_domains WHERE user_id = ?',
        [user.id]
      );
      domains = rows.map(r => r.domain);
    }

    // Stamp session
    req.session.userId        = user.id;
    req.session.username      = user.username;
    req.session.role          = user.role;
    req.session.domains       = domains;       // null = admin (all), array = scoped
    req.session.activeDomain  = domains && domains.length === 1 ? domains[0] : null;

    res.json({ success: true, role: user.role, username: user.username });
  } catch (err) {
    console.error('[auth] login error:', err.message);
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
