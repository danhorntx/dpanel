'use strict';
const express = require('express');
const ssl     = require('../lib/ssl');
const router  = express.Router();

router.get('/', (req, res) => {
  try { res.json({ success: true, data: ssl.listCerts() }); }
  catch (err) { res.json({ success: false, error: err.message }); }
});

router.post('/request', async (req, res) => {
  try {
    const { domains, webroot } = req.body;
    if (!domains || !webroot) return res.json({ success: false, error: 'Domains and webroot required' });
    const out = await ssl.requestCert(domains, webroot);
    res.json({ success: true, data: out });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

router.post('/renew/:domain', async (req, res) => {
  try {
    const out = await ssl.renewCert(req.params.domain);
    res.json({ success: true, data: out });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

router.post('/renew-all', async (req, res) => {
  try {
    const out = await ssl.renewAll();
    res.json({ success: true, data: out });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

module.exports = router;
