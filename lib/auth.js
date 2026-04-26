'use strict';
const { pool } = require('./db');

// ── Core login check (used by every protected route) ─────────────────────────
function requireLogin(req, res, next) {
  if (req.session && req.session.userId) return next();
  // Legacy: support sessions set before the DB migration (req.session.authenticated)
  if (req.session && req.session.authenticated) return next();
  if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
    return res.status(401).json({ success: false, error: 'Not authenticated' });
  }
  res.redirect('/');
}

// ── Admin-only guard ──────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (!req.session || (!req.session.userId && !req.session.authenticated)) {
    return res.status(401).json({ success: false, error: 'Not authenticated' });
  }
  if (req.session.role && req.session.role !== 'admin') {
    return res.status(403).json({ success: false, error: 'Admin access required' });
  }
  next();
}

// ── Domain-scoped guard factory ───────────────────────────────────────────────
// Usage:  router.get('/:domain/...', requireDomainAccess('domain'), handler)
function requireDomainAccess(paramName) {
  return async (req, res, next) => {
    const domain = req.params[paramName] || req.body?.domain || req.query?.domain;
    if (!domain) return res.status(400).json({ success: false, error: 'Domain required' });
    if (!req.session || (!req.session.userId && !req.session.authenticated)) {
      return res.status(401).json({ success: false, error: 'Not authenticated' });
    }
    // Admins always pass
    if (!req.session.role || req.session.role === 'admin') return next();
    // Scoped users must have the domain in their assigned list
    const allowed = req.session.domains || [];
    if (!allowed.includes(domain)) {
      return res.status(403).json({ success: false, error: 'Access denied for this domain' });
    }
    next();
  };
}

// ── Scope helper — returns null for admin (all), array for scoped user ────────
function scopeDomains(req) {
  if (!req.session) return [];
  if (!req.session.role || req.session.role === 'admin') return null; // null = all
  return req.session.domains || [];
}

// ── Load fresh user session data from DB ──────────────────────────────────────
async function refreshSession(req) {
  if (!req.session.userId) return;
  try {
    const [[user]] = await pool.query(
      'SELECT id, username, role FROM dpanel_users WHERE id = ?',
      [req.session.userId]
    );
    if (!user) return;
    const [domRows] = await pool.query(
      'SELECT domain FROM dpanel_user_domains WHERE user_id = ?',
      [user.id]
    );
    req.session.username = user.username;
    req.session.role     = user.role;
    req.session.domains  = domRows.map(r => r.domain);
  } catch (_) {}
}

module.exports = { requireLogin, requireAdmin, requireDomainAccess, scopeDomains, refreshSession };
