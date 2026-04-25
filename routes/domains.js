'use strict';
const express = require('express');
const apache  = require('../lib/apache');
const router  = express.Router();

router.get('/', (req, res) => {
  try { res.json({ success: true, data: apache.listVhosts() }); }
  catch (err) { res.json({ success: false, error: err.message }); }
});

router.post('/', (req, res) => {
  try {
    apache.createVhost(req.body);
    res.json({ success: true });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

router.put('/:domain', (req, res) => {
  try {
    apache.updateVhost(req.params.domain, req.body.content);
    res.json({ success: true });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

router.post('/:domain/enable', (req, res) => {
  try { apache.enableVhost(req.params.domain); res.json({ success: true }); }
  catch (err) { res.json({ success: false, error: err.message }); }
});

router.post('/:domain/disable', (req, res) => {
  try { apache.disableVhost(req.params.domain); res.json({ success: true }); }
  catch (err) { res.json({ success: false, error: err.message }); }
});

router.delete('/:domain', (req, res) => {
  try { apache.deleteVhost(req.params.domain); res.json({ success: true }); }
  catch (err) { res.json({ success: false, error: err.message }); }
});

router.get('/:domain/config', (req, res) => {
  try { res.json({ success: true, data: apache.getVhostConfig(req.params.domain) }); }
  catch (err) { res.json({ success: false, error: err.message }); }
});

module.exports = router;
