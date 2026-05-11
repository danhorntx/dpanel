'use strict';
const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { runAsync, sanitizeDomain, logAction } = require('./shell');
const mysql = require('./mysql');

const BACKUP_DIR = '/opt/dpanel/backups';

function ensureDir() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

// ── List backups ──────────────────────────────────────────────────────────────
function list() {
  ensureDir();
  return fs.readdirSync(BACKUP_DIR)
    .filter(f => f.endsWith('.tar.gz') || f.endsWith('.sql.gz'))
    .map(f => {
      const full = path.join(BACKUP_DIR, f);
      const stat = fs.statSync(full);
      const parts = f.replace(/\.(tar\.gz|sql\.gz)$/, '').split('_');
      const type  = f.endsWith('.sql.gz') ? 'database' : 'files';
      return {
        file:    f,
        path:    full,
        size:    stat.size,
        sizeMb:  Math.round(stat.size / 1024 / 1024 * 10) / 10,
        created: stat.mtime.toISOString(),
        type,
      };
    })
    .sort((a, b) => new Date(b.created) - new Date(a.created));
}

// ── Create file backup ────────────────────────────────────────────────────────
async function backupFiles(domain, docRoot) {
  sanitizeDomain(domain);
  ensureDir();
  const ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = `${domain}_files_${ts}.tar.gz`;
  const out  = path.join(BACKUP_DIR, file);
  await runAsync(`tar -czf ${out} -C ${docRoot} . 2>&1`, 'backup:files', domain);
  logAction('backup:files', domain, file);
  return { file, path: out };
}

// ── Create database backup ────────────────────────────────────────────────────
async function backupDatabase(dbName) {
  ensureDir();
  const ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = `${dbName}_db_${ts}.sql.gz`;
  const out  = path.join(BACKUP_DIR, file);
  await mysql.dumpDatabase(dbName, out);
  logAction('backup:database', dbName, file);
  return { file, path: out };
}

// ── Full backup: files + database ─────────────────────────────────────────────
async function backupAll(domain, docRoot, dbName) {
  const results = {};
  results.files = await backupFiles(domain, docRoot);
  if (dbName && mysql.isInstalled()) {
    try { results.database = await backupDatabase(dbName); } catch (e) { results.dbError = e.message; }
  }
  return results;
}

// ── Restore from file backup ──────────────────────────────────────────────────
// Extracts a *_files_*.tar.gz into the target docroot. If `wipe` is true,
// the target directory is emptied first so we don't merge new files over
// stale ones; otherwise tar's default merge behavior wins. Either way, the
// docroot directory itself is preserved (its permissions/owner are valuable).
async function restoreFiles(file, docRoot, { wipe = false } = {}) {
  if (file.includes('/') || file.includes('..')) throw new Error('Invalid filename.');
  if (!file.endsWith('.tar.gz')) throw new Error('Not a file backup (expected .tar.gz).');
  const full = path.join(BACKUP_DIR, file);
  if (!fs.existsSync(full))   throw new Error('Backup not found.');
  if (!docRoot || !fs.existsSync(docRoot)) throw new Error('Target docroot does not exist.');

  if (wipe) {
    // Clear contents (dotfiles included) but keep the docroot dir itself.
    await runAsync(`find ${docRoot} -mindepth 1 -delete`, 'backup:restore-wipe', file);
  }
  await runAsync(`tar -xzf ${full} -C ${docRoot}`, 'backup:restore-files', file);
  logAction('backup:restore-files', `${file} → ${docRoot}`, 'ok');
  return { file, docRoot, wiped: !!wipe };
}

// ── Restore database from .sql.gz ─────────────────────────────────────────────
// gunzips the file and pipes it into the local mysql client as root. If
// `dropFirst` is true, the target DB is dropped + recreated empty before
// import — closest to a clean restore.
async function restoreDatabase(file, dbName, { dropFirst = false } = {}) {
  if (file.includes('/') || file.includes('..')) throw new Error('Invalid filename.');
  if (!file.endsWith('.sql.gz')) throw new Error('Not a database backup (expected .sql.gz).');
  if (!dbName || !/^[a-zA-Z0-9_]{1,64}$/.test(dbName)) throw new Error('Invalid target database name.');
  const full = path.join(BACKUP_DIR, file);
  if (!fs.existsSync(full)) throw new Error('Backup not found.');

  if (dropFirst) {
    // dbName is sanitized above to [a-zA-Z0-9_]{1,64} — safe unquoted.
    await runAsync(`mysql -u root -e "DROP DATABASE IF EXISTS ${dbName}; CREATE DATABASE ${dbName} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"`, 'backup:restore-drop', dbName);
  }
  // gunzip → mysql via shell. Quoting matters: dbName is sanitized above.
  await runAsync(`gunzip -c ${full} | mysql -u root ${dbName}`, 'backup:restore-db', `${file} → ${dbName}`);
  logAction('backup:restore-database', `${file} → ${dbName}`, 'ok');
  return { file, database: dbName, dropFirst };
}

// ── Delete backup ─────────────────────────────────────────────────────────────
function deleteBackup(file) {
  // Prevent path traversal
  if (file.includes('/') || file.includes('..')) throw new Error('Invalid filename.');
  const full = path.join(BACKUP_DIR, file);
  if (!fs.existsSync(full)) throw new Error('Backup not found.');
  fs.unlinkSync(full);
  logAction('backup:delete', file, 'ok');
}

// ── Cleanup old backups (keep last N per domain) ──────────────────────────────
function cleanup(keepLast = 10) {
  const all = list();
  const byDomain = {};
  all.forEach(b => {
    const domain = b.file.split('_')[0];
    if (!byDomain[domain]) byDomain[domain] = [];
    byDomain[domain].push(b);
  });
  let deleted = 0;
  for (const [, backups] of Object.entries(byDomain)) {
    if (backups.length > keepLast) {
      backups.slice(keepLast).forEach(b => { try { fs.unlinkSync(b.path); deleted++; } catch (_) {} });
    }
  }
  return deleted;
}

module.exports = { list, backupFiles, backupDatabase, backupAll, restoreFiles, restoreDatabase, deleteBackup, cleanup, BACKUP_DIR };
