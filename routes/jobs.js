'use strict';
const express = require('express');
const jobs    = require('../lib/jobqueue');
const router  = express.Router();

router.get('/', (req, res) => {
  res.json({ success: true, data: jobs.list() });
});

router.get('/:id', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ success: false, error: 'Job not found' });
  res.json({ success: true, data: j });
});

router.delete('/:id', (req, res) => {
  const ok = jobs.cancel(req.params.id);
  res.json({ success: ok });
});

module.exports = router;
