'use strict';
const { execSync } = require('child_process');
const { runAsync, logAction } = require('./shell');

const SYSTEM_DBS   = new Set(['information_schema', 'performance_schema', 'mysql', 'sys']);
const SYSTEM_USERS = new Set(['root', 'mysql.sys', 'mysql.session', 'mysql.infoschema', 'debian-sys-maint', 'mariadb.sys']);

function sanitizeId(name, label) {
  if (!/^[a-zA-Z0-9_]{1,64}$/.test(name)) throw new Error(`Invalid ${label}: ${name}`);
  return name;
}

function sql(query) {
  return execSync(`mysql -u root -e ${JSON.stringify(query)} 2>/dev/null`, { encoding: 'utf8', timeout: 10000 });
}

// ── Status ────────────────────────────────────────────────────────────────────
function isInstalled() {
  try { execSync('which mysql 2>/dev/null', { stdio: 'pipe' }); return true; }
  catch (_) { return false; }
}

function isRunning() {
  try {
    return execSync('systemctl is-active mariadb 2>/dev/null || systemctl is-active mysql 2>/dev/null', { encoding: 'utf8' }).trim() === 'active';
  } catch (_) { return false; }
}

async function install() {
  return runAsync('DEBIAN_FRONTEND=noninteractive apt-get install -y mariadb-server 2>&1 && systemctl enable mariadb && systemctl start mariadb', 'mysql:install', 'mariadb');
}

// ── Databases ─────────────────────────────────────────────────────────────────
function listDatabases() {
  const out = sql('SHOW DATABASES;');
  return out.split('\n')
    .map(l => l.trim())
    .filter(l => l && l !== 'Database' && !SYSTEM_DBS.has(l));
}

function createDatabase(name) {
  sanitizeId(name, 'database name');
  sql(`CREATE DATABASE IF NOT EXISTS \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);
  logAction('mysql:create-db', name, 'ok');
}

function dropDatabase(name) {
  sanitizeId(name, 'database name');
  sql(`DROP DATABASE IF EXISTS \`${name}\`;`);
  logAction('mysql:drop-db', name, 'ok');
}

// ── Users ─────────────────────────────────────────────────────────────────────
function listUsers() {
  const out = sql("SELECT User, Host FROM mysql.user ORDER BY User;");
  return out.split('\n')
    .slice(1) // skip header
    .map(l => { const [user, host] = l.trim().split('\t'); return { user, host }; })
    .filter(u => u.user && !SYSTEM_USERS.has(u.user));
}

function createUser(user, password, database) {
  sanitizeId(user, 'username');
  sanitizeId(database, 'database name');
  const escaped = password.replace(/'/g, "\\'");
  sql(`CREATE USER IF NOT EXISTS '${user}'@'localhost' IDENTIFIED BY '${escaped}';`);
  sql(`GRANT ALL PRIVILEGES ON \`${database}\`.* TO '${user}'@'localhost'; FLUSH PRIVILEGES;`);
  logAction('mysql:create-user', user, 'ok');
}

function dropUser(user) {
  sanitizeId(user, 'username');
  sql(`DROP USER IF EXISTS '${user}'@'localhost'; FLUSH PRIVILEGES;`);
  logAction('mysql:drop-user', user, 'ok');
}

function changePassword(user, password) {
  sanitizeId(user, 'username');
  const escaped = password.replace(/'/g, "\\'");
  sql(`ALTER USER '${user}'@'localhost' IDENTIFIED BY '${escaped}'; FLUSH PRIVILEGES;`);
  logAction('mysql:change-pw', user, 'ok');
}

function getDatabaseSize() {
  try {
    const out = sql("SELECT table_schema AS db, ROUND(SUM(data_length + index_length)/1024/1024,2) AS mb FROM information_schema.tables GROUP BY table_schema;");
    const sizes = {};
    out.split('\n').slice(1).forEach(l => {
      const [db, mb] = l.trim().split('\t');
      if (db && mb) sizes[db] = parseFloat(mb);
    });
    return sizes;
  } catch (_) { return {}; }
}

// ── Dump ─────────────────────────────────────────────────────────────────────
async function dumpDatabase(name, outPath) {
  sanitizeId(name, 'database name');
  // No backtick-quoting here: sanitizeId restricts `name` to [a-zA-Z0-9_]{1,64},
  // which is safe to pass unquoted on the shell. (Wrapping in backticks would
  // trigger command substitution — that bug shipped an empty .sql.gz for ages.)
  return runAsync(`mysqldump -u root --single-transaction --routines --triggers ${name} | gzip > ${outPath}`, 'mysql:dump', name);
}

module.exports = { isInstalled, isRunning, install, listDatabases, createDatabase, dropDatabase, listUsers, createUser, dropUser, changePassword, getDatabaseSize, dumpDatabase };
