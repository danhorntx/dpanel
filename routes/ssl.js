'use strict';
const express = require('express');
const ssl     = require('../lib/ssl');
const router  = express.Router();

// ── GET /api/ssl — list all certs ─────────────────────────────────────────────
router.get('/', (req, res) => {
  try { res.json({ success: true, data: ssl.listCerts() }); }
  catch (err) { res.json({ success: false, error: err.message }); }
});

// ── POST /api/ssl/request — manual webroot cert request ──────────────────────
router.post('/request', async (req, res) => {
  try {
    const { domains, webroot } = req.body;
    if (!domains || !webroot) return res.json({ success: false, error: 'Domains and webroot required' });
    const out = await ssl.requestCert(domains, webroot);
    res.json({ success: true, data: out });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// ── POST /api/ssl/auto/:domain — AutoSSL via certbot --apache ─────────────────
router.post('/auto/:domain', async (req, res) => {
  try {
    const { email } = req.body;
    const out = await ssl.autoSSL(req.params.domain, email);
    res.json({ success: true, data: out });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// ── POST /api/ssl/renew/:domain — standard renewal ───────────────────────────
router.post('/renew/:domain', async (req, res) => {
  try {
    const out = await ssl.renewCert(req.params.domain);
    res.json({ success: true, data: out });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// ── POST /api/ssl/renew-all ───────────────────────────────────────────────────
router.post('/renew-all', async (req, res) => {
  try {
    const out = await ssl.renewAll();
    res.json({ success: true, data: out });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// ── POST /api/ssl/reissue/:domain — force-renewal via certbot --apache ────────
router.post('/reissue/:domain', async (req, res) => {
  try {
    const { email } = req.body;
    const out = await ssl.reissueCert(req.params.domain, email);
    res.json({ success: true, data: out });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// ── DELETE /api/ssl/revoke/:domain — delete cert + renewal config ─────────────
router.delete('/revoke/:domain', async (req, res) => {
  try {
    const out = await ssl.revokeCert(req.params.domain);
    res.json({ success: true, data: out });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

module.exports = router;
