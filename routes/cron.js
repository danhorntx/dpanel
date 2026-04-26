'use strict';
const express = require('express');
const cron    = require('../lib/cron');
const router  = express.Router();

// GET /api/cron
router.get('/', (req, res) => {
  try {
    const jobs = cron.list().map((j, i) => ({
      index:       i,
      schedule:    j.schedule,
      description: cron.describeSchedule(j.schedule),
      command:     j.command,
    }));
    res.json({ success: true, data: jobs });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// POST /api/cron
router.post('/', (req, res) => {
  try {
    const { schedule, command } = req.body;
    if (!schedule || !command) return res.json({ success: false, error: 'Schedule and command required.' });
    cron.add(schedule, command);
    res.json({ success: true });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// DELETE /api/cron/:index
router.delete('/:index', (req, res) => {
  try {
    const idx = parseInt(req.params.index, 10);
    if (isNaN(idx)) return res.json({ success: false, error: 'Invalid index.' });
    cron.remove(idx);
    res.json({ success: true });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

module.exports = router;
