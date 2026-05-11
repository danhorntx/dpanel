'use strict';
/**
 * routes/apikeys.js — API key management.
 *
 * All endpoints are admin-only. Creating a key returns the raw value ONCE —
 * after that, only the prefix is queryable. Audit-logged so every key
 * lifecycle event has a record.
 */

const express = require('express');
const apikey  = require('../lib/apikey');
const { requireAdmin } = require('../lib/auth');
const { audit } = require('../lib/db');
const router  = express.Router();

router.use(requireAdmin);

// GET /api/keys — list all keys (no raw, no hash, just metadata)
router.get('/', async (req, res) => {
  try { res.json({ success: true, data: await apikey.listKeys() }); }
  catch (err) { res.json({ success: false, error: err.message }); }
});

// POST /api/keys — create a new key. Returns the raw value ONCE; UI must
// surface it prominently because we cannot show it again.
router.post('/', async (req, res) => {
  try {
    const { name, scope, expires_at } = req.body;
    const session = req.session?.userId ? req.session : req.apiAuth;
    const created = await apikey.createKey({
      name,
      scope:     scope || 'admin',
      createdBy: session?.userId,
      expiresAt: expires_at || null,
    });
    await audit(session?.userId, session?.username, 'apikey:create', name, `scope=${scope || 'admin'}`, req.ip);
    res.json({ success: true, data: created });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// DELETE /api/keys/:id — revoke
router.delete('/:id', async (req, res) => {
  try {
    const ok = await apikey.revokeKey(parseInt(req.params.id, 10));
    const session = req.session?.userId ? req.session : req.apiAuth;
    if (ok) await audit(session?.userId, session?.username, 'apikey:revoke', String(req.params.id), null, req.ip);
    res.json({ success: ok });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// GET /api/keys/whoami — handy for verifying a key works. Returns the
// effective auth source for the current request.
router.get('/whoami', (req, res) => {
  if (req.apiAuth) {
    return res.json({ success: true, via: 'apikey', key: req.apiAuth.keyName, scope: req.apiAuth.role, readOnly: req.apiAuth.readOnly });
  }
  if (req.session?.userId) {
    return res.json({ success: true, via: 'session', user: req.session.username, role: req.session.role });
  }
  res.status(401).json({ success: false, error: 'No auth' });
});

module.exports = router;
