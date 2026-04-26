'use strict';
const express  = require('express');
const firewall = require('../lib/firewall');
const router   = express.Router();

// GET /api/firewall
router.get('/', (req, res) => {
  try {
    const status = firewall.getStatus();
    const rules  = firewall.listRules();
    res.json({ success: true, data: { enabled: status.enabled, rules } });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// POST /api/firewall/enable
router.post('/enable', (req, res) => {
  try { firewall.enable(); res.json({ success: true }); }
  catch (err) { res.json({ success: false, error: err.message }); }
});

// POST /api/firewall/disable
router.post('/disable', (req, res) => {
  try { firewall.disable(); res.json({ success: true }); }
  catch (err) { res.json({ success: false, error: err.message }); }
});

// POST /api/firewall/allow
router.post('/allow', (req, res) => {
  try {
    const { port, proto, comment } = req.body;
    if (!port) return res.json({ success: false, error: 'Port required.' });
    firewall.allowPort(port, proto || 'tcp', comment || '');
    res.json({ success: true });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// POST /api/firewall/deny
router.post('/deny', (req, res) => {
  try {
    const { port, proto } = req.body;
    if (!port) return res.json({ success: false, error: 'Port required.' });
    firewall.denyPort(port, proto || 'tcp');
    res.json({ success: true });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// POST /api/firewall/block-ip
router.post('/block-ip', (req, res) => {
  try {
    const { ip } = req.body;
    if (!ip) return res.json({ success: false, error: 'IP required.' });
    firewall.blockIp(ip);
    res.json({ success: true });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// DELETE /api/firewall/:num
router.delete('/:num', (req, res) => {
  try {
    firewall.deleteRule(parseInt(req.params.num, 10));
    res.json({ success: true });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

module.exports = router;
