'use strict';
const express = require('express');
const crypto  = require('crypto');
const mysql   = require('../lib/mysql');
const router  = express.Router();

function genPw() {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from(crypto.randomBytes(20)).map(b => chars[b % chars.length]).join('');
}

// ── GET /api/mysql ────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  try {
    if (!mysql.isInstalled()) return res.json({ success: true, data: { installed: false } });
    const sizes = mysql.getDatabaseSize();
    const dbs   = mysql.listDatabases().map(name => ({ name, sizeMb: sizes[name] || 0 }));
    const users = mysql.listUsers();
    res.json({ success: true, data: { installed: true, running: mysql.isRunning(), databases: dbs, users } });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// ── POST /api/mysql/install ───────────────────────────────────────────────────
router.post('/install', async (req, res) => {
  try {
    await mysql.install();
    res.json({ success: true });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// ── POST /api/mysql/databases ─────────────────────────────────────────────────
router.post('/databases', (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.json({ success: false, error: 'Name required.' });
    mysql.createDatabase(name);
    res.json({ success: true });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// ── DELETE /api/mysql/databases/:name ────────────────────────────────────────
router.delete('/databases/:name', (req, res) => {
  try {
    mysql.dropDatabase(req.params.name);
    res.json({ success: true });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// ── POST /api/mysql/users ─────────────────────────────────────────────────────
router.post('/users', (req, res) => {
  try {
    const { user, password, database } = req.body;
    if (!user || !database) return res.json({ success: false, error: 'User and database required.' });
    const pw = password || genPw();
    mysql.createUser(user, pw, database);
    res.json({ success: true, data: { user, password: pw, database } });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// ── DELETE /api/mysql/users/:name ─────────────────────────────────────────────
router.delete('/users/:name', (req, res) => {
  try {
    mysql.dropUser(req.params.name);
    res.json({ success: true });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// ── PUT /api/mysql/users/:name/password ──────────────────────────────────────
router.put('/users/:name/password', (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.json({ success: false, error: 'Password required.' });
    mysql.changePassword(req.params.name, password);
    res.json({ success: true });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

module.exports = router;
