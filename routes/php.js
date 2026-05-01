'use strict';
const express = require('express');
const php     = require('../lib/php');
const apache  = require('../lib/apache');
const router  = express.Router();

// ── GET /api/php ──────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  try {
    const installed = php.listInstalled();
    const available = php.listAvailable();
    // Domain list — skip certbot-generated SSL confs
    const vhosts  = apache.listVhosts().filter(v => !v.domain.endsWith('-le-ssl'));
    const domains = vhosts.map(v => ({
      domain:     v.domain,
      phpVersion: php.getDomainPhp(v.domain),
    }));
    res.json({ success: true, data: { installed, available, domains } });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// ── POST /api/php/install ─────────────────────────────────────────────────────
router.post('/install', async (req, res) => {
  try {
    const { version } = req.body;
    if (!version) return res.json({ success: false, error: 'Version required.' });
    const out = await php.installVersion(version);
    res.json({ success: true, data: out });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// ── POST /api/php/default ─────────────────────────────────────────────────────
router.post('/default', (req, res) => {
  try {
    const { version } = req.body;
    if (!version) return res.json({ success: false, error: 'Version required.' });
    php.setDefault(version);
    res.json({ success: true });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// ── POST /api/php/domain — per-domain version override ────────────────────────
router.post('/domain', (req, res) => {
  try {
    const { domain, version } = req.body;
    if (!domain) return res.json({ success: false, error: 'Domain required.' });
    php.setDomainPhp(domain, version || null);
    res.json({ success: true });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// ── DELETE /api/php/:version ──────────────────────────────────────────────────
router.delete('/:version', async (req, res) => {
  try {
    const out = await php.removeVersion(req.params.version);
    res.json({ success: true, data: out });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

module.exports = router;
