'use strict';
const express = require('express');
const path    = require('path');
const fs      = require('fs');
const backup  = require('../lib/backup');
const apache  = require('../lib/apache');
const router  = express.Router();

// GET /api/backup
router.get('/', (req, res) => {
  try { res.json({ success: true, data: backup.list() }); }
  catch (err) { res.json({ success: false, error: err.message }); }
});

// POST /api/backup — create backup
router.post('/', async (req, res) => {
  try {
    const { domain, type } = req.body;
    if (!domain) return res.json({ success: false, error: 'Domain required.' });

    const vhosts  = apache.listVhosts().filter(v => !v.domain.endsWith('-le-ssl'));
    const vhost   = vhosts.find(v => v.domain === domain);
    if (!vhost) return res.json({ success: false, error: 'Domain not found.' });

    let result;
    if (type === 'database') {
      const dbName = req.body.database;
      if (!dbName) return res.json({ success: false, error: 'Database name required.' });
      result = await backup.backupDatabase(dbName);
    } else if (type === 'files') {
      result = await backup.backupFiles(domain, vhost.docRoot);
    } else {
      result = await backup.backupAll(domain, vhost.docRoot, req.body.database || null);
    }
    res.json({ success: true, data: result });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// GET /api/backup/download/:file — download a backup file
router.get('/download/:file', (req, res) => {
  try {
    const file = req.params.file;
    if (file.includes('/') || file.includes('..')) return res.status(400).json({ success: false, error: 'Invalid filename.' });
    const fullPath = path.join(backup.BACKUP_DIR, file);
    if (!fs.existsSync(fullPath)) return res.status(404).json({ success: false, error: 'Not found.' });
    res.download(fullPath, file);
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// DELETE /api/backup/:file
router.delete('/:file', (req, res) => {
  try {
    backup.deleteBackup(req.params.file);
    res.json({ success: true });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// POST /api/backup/cleanup
router.post('/cleanup', (req, res) => {
  try {
    const deleted = backup.cleanup(req.body.keepLast || 10);
    res.json({ success: true, data: { deleted } });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

module.exports = router;
