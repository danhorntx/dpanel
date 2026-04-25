'use strict';
const express = require('express');
const mail    = require('../lib/mail');
const router  = express.Router();

// Accounts
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

// Forwards
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

module.exports = router;
