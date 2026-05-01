'use strict';
const express = require('express');
const { requireAdmin } = require('../lib/auth');
const users   = require('../lib/users');
const { audit, pool } = require('../lib/db');
const router  = express.Router();

// All user-management endpoints are admin-only
router.use(requireAdmin);

// GET /api/users/audit-log — recent audit log entries (must be before /:id)
router.get('/audit-log', async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit  || '200', 10), 1000);
    const offset = parseInt(req.query.offset || '0', 10);
    const action = req.query.action || null;

    let query = 'SELECT * FROM dpanel_audit_log';
    const params = [];
    if (action) { query += ' WHERE action LIKE ?'; params.push(`%${action}%`); }
    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const [rows] = await pool.query(query, params);
    const [[{ total }]] = await pool.query(
      action
        ? 'SELECT COUNT(*) AS total FROM dpanel_audit_log WHERE action LIKE ?'
        : 'SELECT COUNT(*) AS total FROM dpanel_audit_log',
      action ? [`%${action}%`] : []
    );
    res.json({ success: true, data: rows, total });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// GET /api/users/login-attempts — recent login attempt history
router.get('/login-attempts', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);
    const [rows] = await pool.query(
      'SELECT * FROM dpanel_login_attempts ORDER BY created_at DESC LIMIT ?',
      [limit]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// GET /api/users
router.get('/', async (req, res) => {
  try {
    res.json({ success: true, data: await users.listUsers() });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// GET /api/users/:id
router.get('/:id', async (req, res) => {
  try {
    const user = await users.getUser(Number(req.params.id));
    if (!user) return res.json({ success: false, error: 'User not found' });
    res.json({ success: true, data: user });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// POST /api/users
router.post('/', async (req, res) => {
  try {
    const { username, password, role, domains } = req.body;
    const id = await users.createUser({ username, password, role, domains: domains || [] });
    audit(req.session.userId, req.session.username, 'user:create', username, `role=${role}`, req.ip);
    res.json({ success: true, id });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// PUT /api/users/:id
router.put('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { password, role, domains } = req.body;
    // Prevent removing last admin
    if (role === 'user') {
      const all = await users.listUsers();
      const admins = all.filter(u => u.role === 'admin' && u.id !== id);
      if (!admins.length) return res.json({ success: false, error: 'Cannot demote last admin' });
    }
    await users.updateUser(id, { password, role, domains });
    audit(req.session.userId, req.session.username, 'user:update', String(id), null, req.ip);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// DELETE /api/users/:id
router.delete('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (id === req.session.userId) return res.json({ success: false, error: 'Cannot delete yourself' });
    await users.deleteUser(id);
    audit(req.session.userId, req.session.username, 'user:delete', String(id), null, req.ip);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

module.exports = router;
