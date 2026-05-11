'use strict';
const { pool } = require('./db');

// ── API key middleware ────────────────────────────────────────────────────────
// If the request has `Authorization: Bearer dpk_...`, look the key up and
// stamp `req.apiAuth` with { userId, username, role, keyId }. This runs
// BEFORE requireLogin / requireAdmin so those can accept either auth source.
async function acceptApiKey(req, res, next) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return next();
  const raw = auth.slice(7).trim();
  if (!raw.startsWith('dpk_')) return next();
  try {
    const apikey = require('./apikey');
    const row    = await apikey.lookupKey(raw);
    if (!row) return next();   // unknown/expired key — fall through to session auth
    req.apiAuth = {
      userId:   row.created_by,
      username: row.username || `apikey:${row.name}`,
      role:     row.scope === 'admin' ? 'admin' : 'user',
      readOnly: row.scope === 'read',
      keyId:    row.id,
      keyName:  row.name,
    };
    apikey.touchKey(row.id, req.ip);
  } catch (_) { /* never block a request on apikey resolution */ }
  next();
}

// `read`-scoped keys can only call GET/HEAD. Caller-side opt-in via
// requireWritableAuth — apply on routes that must reject read-only keys.
function requireWritableAuth(req, res, next) {
  if (req.apiAuth && req.apiAuth.readOnly && !['GET', 'HEAD'].includes(req.method)) {
    return res.status(403).json({ success: false, error: 'API key is read-only' });
  }
  next();
}

// Identify the effective auth for this request — session or API key.
function _effectiveAuth(req) {
  if (req.session && req.session.userId) {
    return { userId: req.session.userId, role: req.session.role || 'user', via: 'session' };
  }
  if (req.apiAuth) {
    return { userId: req.apiAuth.userId, role: req.apiAuth.role, via: 'apikey' };
  }
  return null;
}

// ── Core login check (used by every protected route) ─────────────────────────
function requireLogin(req, res, next) {
  if (_effectiveAuth(req)) return next();
  if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
    return res.status(401).json({ success: false, error: 'Not authenticated' });
  }
  res.redirect('/');
}

// ── Admin-only guard ──────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const auth = _effectiveAuth(req);
  if (!auth) return res.status(401).json({ success: false, error: 'Not authenticated' });
  if (auth.role && auth.role !== 'admin') {
    return res.status(403).json({ success: false, error: 'Admin access required' });
  }
  // Read-only keys cannot perform admin write actions even with admin scope
  if (req.apiAuth && req.apiAuth.readOnly && !['GET', 'HEAD'].includes(req.method)) {
    return res.status(403).json({ success: false, error: 'API key is read-only' });
  }
  next();
}

// ── Domain-scoped guard factory ───────────────────────────────────────────────
// Usage:  router.get('/:domain/...', requireDomainAccess('domain'), handler)
function requireDomainAccess(paramName) {
  return async (req, res, next) => {
    const domain = req.params[paramName] || req.body?.domain || req.query?.domain;
    if (!domain) return res.status(400).json({ success: false, error: 'Domain required' });
    if (!req.session || !req.session.userId) {
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

module.exports = { requireLogin, requireAdmin, requireDomainAccess, scopeDomains, refreshSession, acceptApiKey, requireWritableAuth };
