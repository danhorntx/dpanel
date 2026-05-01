'use strict';
const express = require('express');
const git     = require('../lib/git');
const apache  = require('../lib/apache');
const router  = express.Router();

// GET /api/git — list all configured deploys
router.get('/', (req, res) => {
  try {
    const vhosts  = apache.listVhosts().filter(v => !v.domain.endsWith('-le-ssl'));
    const deploys = vhosts.map(v => ({
      domain: v.domain,
      config: git.getConfig(v.domain),
    }));
    res.json({ success: true, data: deploys });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// GET /api/git/:domain
router.get('/:domain', (req, res) => {
  try {
    const cfg = git.getConfig(req.params.domain);
    res.json({ success: true, data: cfg });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// POST /api/git/:domain — save config
router.post('/:domain', (req, res) => {
  try {
    const { repoUrl, branch, buildCommand } = req.body;
    const vhosts = apache.listVhosts().filter(v => !v.domain.endsWith('-le-ssl'));
    const vhost  = vhosts.find(v => v.domain === req.params.domain);
    if (!vhost) return res.json({ success: false, error: 'Domain not found.' });
    const cfg = git.saveConfig(req.params.domain, { repoUrl, branch, buildCommand, docRoot: vhost.docRoot });
    res.json({ success: true, data: cfg });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// POST /api/git/:domain/deploy — manual deploy
router.post('/:domain/deploy', async (req, res) => {
  try {
    const result = await git.deploy(req.params.domain);
    res.json({ success: true, data: result });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// DELETE /api/git/:domain
router.delete('/:domain', (req, res) => {
  try {
    git.removeConfig(req.params.domain);
    res.json({ success: true });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// POST /api/git/webhook/:domain — GitHub/GitLab webhook
router.post('/webhook/:domain', express.raw({ type: '*/*' }), (req, res) => {
  try {
    const sig = req.headers['x-hub-signature-256'] || req.headers['x-gitlab-token'] || '';
    if (!git.verifyWebhook(req.params.domain, sig, req.body)) {
      return res.status(401).json({ success: false, error: 'Invalid signature.' });
    }
    // Fire and forget
    git.deploy(req.params.domain).catch(console.error);
    res.json({ success: true, message: 'Deploy triggered.' });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

module.exports = router;
