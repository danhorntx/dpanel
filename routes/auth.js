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
      'SELECT id, username, password_hash, role FROM dpanel_users WHERE username = ?',
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

    // Successful login — record it and clear any lockout stigma in session
    await recordAttempt(req.ip, username, true);

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
