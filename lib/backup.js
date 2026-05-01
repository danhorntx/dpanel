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

module.exports = { list, backupFiles, backupDatabase, backupAll, deleteBackup, cleanup, BACKUP_DIR };
