'use strict';
const express = require('express');
const fs      = require('fs');
const path    = require('path');
const router  = express.Router();

const SOURCES = {
  apache_access:  '/var/log/apache2/access.log',
  apache_error:   '/var/log/apache2/error.log',
  mail:           '/var/log/mail.log',
  panel:          path.join(__dirname, '..', 'logs', 'panel.log'),
};

router.get('/', (req, res) => {
  const source = req.query.source || 'panel';
  const lines  = parseInt(req.query.lines || '200', 10);
  const logPath = SOURCES[source];
  if (!logPath) return res.json({ success: false, error: 'Unknown log source' });
  try {
    if (!fs.existsSync(logPath)) return res.json({ success: true, data: [] });
    const { execSync } = require('child_process');
    const content = execSync(`tail -n ${lines} ${logPath}`, { encoding: 'utf8' });
    res.json({ success: true, data: content.split('\n').filter(Boolean) });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

router.get('/download', (req, res) => {
  const source = req.query.source || 'panel';
  const logPath = SOURCES[source];
  if (!logPath) return res.status(400).send('Unknown source');
  if (!fs.existsSync(logPath)) return res.status(404).send('Log not found');
  res.download(logPath, path.basename(logPath));
});

module.exports = router;
