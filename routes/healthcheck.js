'use strict';
const express = require('express');
const hc      = require('../lib/healthcheck');
const apache  = require('../lib/apache');
const router  = express.Router();

// GET /api/healthcheck/:domain
router.get('/:domain', async (req, res) => {
  try {
    const result = await hc.check(req.params.domain);
    res.json({ success: true, data: result });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// GET /api/healthcheck — check all domains
router.get('/', async (req, res) => {
  try {
    const vhosts  = apache.listVhosts().filter(v => !v.domain.endsWith('-le-ssl'));
    const results = await Promise.all(vhosts.map(v => hc.check(v.domain).catch(e => ({ domain: v.domain, error: e.message }))));
    res.json({ success: true, data: results });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

module.exports = router;
