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
  const { domain, type } = req.body;
  try {
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
  } catch (err) {
    // Alert the operator on backup failures — silent failures are how empty
    // backups end up in the corner for months. Best-effort, never throws.
    try {
      const notify = require('../lib/notify');
      notify.sendAlert({
        key:     `backup-fail:${domain}:${type || 'all'}`,
        subject: `[DPanel] Backup failed for ${domain} (${type || 'all'})`,
        body:    `A backup of ${domain} (${type || 'all'}) failed.\n\nError: ${err.message}\n\n` +
                 `Try again from the panel → Backups, or check journalctl -u dpanel for details.`,
      }).catch(() => {});
    } catch (_) {}
    res.json({ success: false, error: err.message });
  }
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

// POST /api/backup/restore/files — body: { file, domain, wipe }
// Restores a *_files_*.tar.gz into a target domain's docroot. `wipe` clears
// the docroot first (closest to a clean restore); without it, tar merges
// over existing files. Either way, the user must type the domain name in
// the UI to confirm — guard rendered there, not enforced here.
router.post('/restore/files', async (req, res) => {
  try {
    const { file, domain, wipe } = req.body;
    if (!file || !domain) return res.json({ success: false, error: 'file and domain required.' });
    const vhosts = apache.listVhosts().filter(v => !v.domain.endsWith('-le-ssl'));
    const vhost  = vhosts.find(v => v.domain === domain);
    if (!vhost) return res.json({ success: false, error: 'Domain not found.' });

    const result = await backup.restoreFiles(file, vhost.docRoot, { wipe: !!wipe });
    try {
      const { audit } = require('../lib/db');
      await audit(req.session.userId, req.session.username, 'backup:restore-files', `${file} → ${domain}`, `wipe=${!!wipe}`, req.ip);
    } catch (_) {}
    res.json({ success: true, data: result });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// POST /api/backup/restore/database — body: { file, database, dropFirst }
router.post('/restore/database', async (req, res) => {
  try {
    const { file, database, dropFirst } = req.body;
    if (!file || !database) return res.json({ success: false, error: 'file and database required.' });
    const result = await backup.restoreDatabase(file, database, { dropFirst: !!dropFirst });
    try {
      const { audit } = require('../lib/db');
      await audit(req.session.userId, req.session.username, 'backup:restore-database', `${file} → ${database}`, `dropFirst=${!!dropFirst}`, req.ip);
    } catch (_) {}
    res.json({ success: true, data: result });
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
