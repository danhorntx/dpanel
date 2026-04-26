'use strict';
const express = require('express');
const mail    = require('../lib/mail');
const dkim    = require('../lib/dkim');
const router  = express.Router();

// ── Accounts ──────────────────────────────────────────────────────────────────
router.get('/accounts', (req, res) => {
  try { res.json({ success: true, data: mail.listAccounts() }); }
  catch (err) { res.json({ success: false, error: err.message }); }
});

router.post('/accounts', async (req, res) => {
  try {
    const { email, password, quota } = req.body;
    if (!email || !password) return res.json({ success: false, error: 'Email and password required' });
    await mail.addAccount(email, password, quota);
    res.json({ success: true });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

router.put('/accounts/:email', async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.json({ success: false, error: 'Password required' });
    await mail.changePassword(req.params.email, password);
    res.json({ success: true });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

router.delete('/accounts/:email', (req, res) => {
  try { mail.deleteAccount(req.params.email); res.json({ success: true }); }
  catch (err) { res.json({ success: false, error: err.message }); }
});

// ── Forwards ──────────────────────────────────────────────────────────────────
router.get('/forwards', (req, res) => {
  try { res.json({ success: true, data: mail.listForwards() }); }
  catch (err) { res.json({ success: false, error: err.message }); }
});

router.post('/forwards', (req, res) => {
  try {
    const { source, destinations } = req.body;
    if (!source || !destinations) return res.json({ success: false, error: 'Source and destinations required' });
    mail.addForward(source, destinations);
    res.json({ success: true });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

router.delete('/forwards/:source', (req, res) => {
  try { mail.deleteForward(req.params.source); res.json({ success: true }); }
  catch (err) { res.json({ success: false, error: err.message }); }
});

// ── DKIM ──────────────────────────────────────────────────────────────────────
// GET /api/mail/dkim/:domain  → check status + public key
router.get('/dkim/:domain', (req, res) => {
  try {
    const { domain } = req.params;
    const has = dkim.hasDkim(domain);
    const pub = has ? dkim.getPublicKey(domain) : null;
    res.json({ success: true, data: { enabled: has, publicKey: pub } });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// POST /api/mail/dkim/:domain  → generate key pair
router.post('/dkim/:domain', async (req, res) => {
  try {
    const pub = await dkim.generateKey(req.params.domain);
    res.json({ success: true, data: { publicKey: pub } });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// DELETE /api/mail/dkim/:domain  → remove DKIM for domain
router.delete('/dkim/:domain', (req, res) => {
  try {
    dkim.removeKey(req.params.domain);
    res.json({ success: true });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// ── DNS Records ───────────────────────────────────────────────────────────────
// GET /api/mail/dns/:domain  → recommended DNS records for email
router.get('/dns/:domain', async (req, res) => {
  try {
    const { domain } = req.params;
    // Detect server IP
    let serverIp = '';
    try {
      const { execSync } = require('child_process');
      serverIp = execSync('curl -sf https://api.ipify.org || hostname -I | awk \'{print $1}\'', { timeout: 5000 }).toString().trim();
    } catch (_) {}
    const records  = dkim.getDnsRecords(domain, serverIp);
    const verified = await dkim.verifyDns(domain);
    res.json({ success: true, data: { records, verified } });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

module.exports = router;
