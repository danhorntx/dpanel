'use strict';
const express  = require('express');
const fs       = require('fs');
const path     = require('path');
const { execSync } = require('child_process');
const { sanitizeDomain } = require('../lib/shell');
const router   = express.Router();

const SOURCES = {
  apache_access:  '/var/log/apache2/access.log',
  apache_error:   '/var/log/apache2/error.log',
  mail:           '/var/log/mail.log',
  panel:          path.join(__dirname, '..', 'logs', 'panel.log'),
};

const LOG_DIR = '/var/log/apache2';

router.get('/', (req, res) => {
  const source  = req.query.source || 'panel';
  const lines   = Math.min(parseInt(req.query.lines || '200', 10), 2000);
  const logPath = SOURCES[source];
  if (!logPath) return res.json({ success: false, error: 'Unknown log source' });
  try {
    if (!fs.existsSync(logPath)) return res.json({ success: true, data: [] });
    const content = execSync(`tail -n ${lines} "${logPath}"`, { encoding: 'utf8' });
    res.json({ success: true, data: content.split('\n').filter(Boolean) });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ── GET /api/logs/domain/:domain — per-domain Apache error log ────────────────
router.get('/domain/:domain', (req, res) => {
  try {
    sanitizeDomain(req.params.domain);
    const lines = Math.min(parseInt(req.query.lines || '300', 10), 2000);
    const domain = req.params.domain;

    // Apache vhost logs created by DPanel use <domain>_error.log
    const candidates = [
      path.join(LOG_DIR, `${domain}_error.log`),
      path.join(LOG_DIR, `${domain}-error.log`),
      path.join(LOG_DIR, `${domain}.error.log`),
    ];
    const logPath = candidates.find(p => fs.existsSync(p));

    if (!logPath) {
      return res.json({ success: true, data: [], note: 'No error log found for this domain yet.' });
    }
    const content = execSync(`tail -n ${lines} "${logPath}"`, { encoding: 'utf8' });
    res.json({ success: true, data: content.split('\n').filter(Boolean), logPath });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ── GET /api/logs/domain/:domain/access — per-domain Apache access log ────────
router.get('/domain/:domain/access', (req, res) => {
  try {
    sanitizeDomain(req.params.domain);
    const lines = Math.min(parseInt(req.query.lines || '300', 10), 2000);
    const domain = req.params.domain;

    const candidates = [
      path.join(LOG_DIR, `${domain}_access.log`),
      path.join(LOG_DIR, `${domain}-access.log`),
    ];
    const logPath = candidates.find(p => fs.existsSync(p));

    if (!logPath) {
      return res.json({ success: true, data: [], note: 'No access log found for this domain yet.' });
    }
    const content = execSync(`tail -n ${lines} "${logPath}"`, { encoding: 'utf8' });
    res.json({ success: true, data: content.split('\n').filter(Boolean), logPath });
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
