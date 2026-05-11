'use strict';
const express = require('express');
const mgr     = require('../lib/appmanager');
const { requireAdmin } = require('../lib/auth');
const { audit } = require('../lib/db');
const router  = express.Router();

router.use(requireAdmin);

router.get('/', async (req, res) => {
  try { res.json({ success: true, data: await mgr.listApps() }); }
  catch (err) { res.json({ success: false, error: err.message }); }
});

router.post('/', async (req, res) => {
  try {
    const result = await mgr.createApp(req.body);
    await audit(req.session?.userId, req.session?.username, 'app:create', result.name, JSON.stringify({ domain: result.domain, port: result.port }), req.ip);
    res.json({ success: true, data: result });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

router.delete('/:name', async (req, res) => {
  try {
    const result = await mgr.destroyApp(req.params.name);
    await audit(req.session?.userId, req.session?.username, 'app:destroy', result.name, null, req.ip);
    res.json({ success: true, data: result });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

router.post('/:name/start',   async (req, res) => { try { res.json({ success: true, data: await mgr.controlApp(req.params.name, 'start')   }); } catch (e) { res.json({ success: false, error: e.message }); } });
router.post('/:name/stop',    async (req, res) => { try { res.json({ success: true, data: await mgr.controlApp(req.params.name, 'stop')    }); } catch (e) { res.json({ success: false, error: e.message }); } });
router.post('/:name/restart', async (req, res) => { try { res.json({ success: true, data: await mgr.controlApp(req.params.name, 'restart') }); } catch (e) { res.json({ success: false, error: e.message }); } });

router.get('/:name/logs', (req, res) => {
  try { res.json({ success: true, data: mgr.getLogs(req.params.name, req.query.lines) }); }
  catch (err) { res.json({ success: false, error: err.message }); }
});

module.exports = router;
