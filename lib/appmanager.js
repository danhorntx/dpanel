'use strict';
/**
 * lib/appmanager.js — Node / Python / custom app manager backed by PM2.
 *
 * Each "app" is:
 *   • a record in dpanel_apps  (name, domain, docroot, start cmd, port, env)
 *   • a PM2 process (`pm2 start ... --name <name>`)
 *   • an Apache reverse-proxy vhost (domain → http://127.0.0.1:<port>)
 *
 * One app per domain. The original static vhost (if any) is replaced when
 * the app is created and restored to a placeholder on destroy.
 *
 * Port allocation lives in the DB (UNIQUE on port) — we pick the next free
 * value in 3000..3999. PM2 process status is fetched live via `pm2 jlist`
 * and joined with our DB rows.
 */

const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { pool } = require('./db');
const apache   = require('./apache');
const { sanitizeDomain } = require('./shell');

const SITES_AVAILABLE = '/etc/apache2/sites-available';
const PM2_LOG_DIR     = '/root/.pm2/logs';
const PORT_RANGE      = { min: 3000, max: 3999 };

// ── Helpers ───────────────────────────────────────────────────────────────────

function sanitizeAppName(name) {
  if (typeof name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
    throw new Error('App name must be 1–64 chars [a-zA-Z0-9_-]');
  }
  return name;
}

async function _pickFreePort() {
  // Random walk through the range until we find one not in dpanel_apps.
  // ~1000 candidates and one-at-a-time lookups is fine for our scale.
  const [rows] = await pool.query('SELECT port FROM dpanel_apps');
  const taken  = new Set(rows.map(r => r.port));
  for (let p = PORT_RANGE.min; p <= PORT_RANGE.max; p++) {
    if (!taken.has(p)) return p;
  }
  throw new Error('No free ports in 3000-3999 — destroy an app first');
}

function _pm2List() {
  try {
    const out = execFileSync('pm2', ['jlist'], { encoding: 'utf8', timeout: 10000 });
    return JSON.parse(out);
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error('PM2 not installed. Run `npm install -g pm2` on the server.');
    return [];
  }
}

function _pm2Status(name) {
  const procs = _pm2List();
  const proc  = procs.find(p => p.name === name);
  if (!proc) return { state: 'absent', cpu: null, memMb: null, pid: null, uptimeMs: null, restarts: null };
  return {
    state:    proc.pm2_env?.status || 'unknown',
    cpu:      proc.monit?.cpu,
    memMb:    proc.monit?.memory ? +(proc.monit.memory / 1024 / 1024).toFixed(1) : null,
    pid:      proc.pid || null,
    uptimeMs: proc.pm2_env?.pm_uptime ? Date.now() - proc.pm2_env.pm_uptime : null,
    restarts: proc.pm2_env?.restart_time ?? null,
  };
}

// ── Apache vhost generation ───────────────────────────────────────────────────
// Replaces the existing <domain>.conf with a reverse-proxy version. Includes
// the same ACME alias as the webmail vhost so renewals still work.
function _writeProxyVhost(domain, port) {
  sanitizeDomain(domain);
  const confPath = path.join(SITES_AVAILABLE, `${domain}.conf`);
  const conf = `<VirtualHost *:80>
    ServerName ${domain}

    # Reverse proxy for app on port ${port} — managed by DPanel app manager
    Alias /.well-known/acme-challenge/ /var/www/html/.well-known/acme-challenge/
    ProxyPass /.well-known/acme-challenge/ !
    <Directory /var/www/html/.well-known/acme-challenge/>
        Options None
        AllowOverride None
        Require all granted
    </Directory>

    ProxyPreserveHost On
    ProxyPass        / http://127.0.0.1:${port}/
    ProxyPassReverse / http://127.0.0.1:${port}/

    ErrorLog \${APACHE_LOG_DIR}/${domain}_error.log
    CustomLog \${APACHE_LOG_DIR}/${domain}_access.log combined
</VirtualHost>
`;
  fs.writeFileSync(confPath, conf);
  // certbot-managed SSL twin: if one exists, patch its proxy block too so HTTPS works.
  const sslPath = path.join(SITES_AVAILABLE, `${domain}-le-ssl.conf`);
  if (fs.existsSync(sslPath)) {
    let sslConf = fs.readFileSync(sslPath, 'utf8');
    // Rewrite or insert ProxyPass directives. If a different port is already
    // proxied, we replace it; otherwise we append before </VirtualHost>.
    sslConf = sslConf.replace(/ProxyPass\s+\/\s+http:\/\/127\.0\.0\.1:\d+\/[^\n]*\n/, '');
    sslConf = sslConf.replace(/ProxyPassReverse\s+\/\s+http:\/\/127\.0\.0\.1:\d+\/[^\n]*\n/, '');
    sslConf = sslConf.replace(
      /<\/VirtualHost>/,
      `    ProxyPreserveHost On\n    ProxyPass        / http://127.0.0.1:${port}/\n    ProxyPassReverse / http://127.0.0.1:${port}/\n</VirtualHost>`
    );
    fs.writeFileSync(sslPath, sslConf);
  }
  apache.assertHostnamesAvailable([domain], `${domain}.conf`);   // sanity
  try { execFileSync('apache2ctl', ['configtest'], { stdio: 'pipe' }); } catch (e) { throw new Error('Apache config invalid: ' + e.message); }
  execFileSync('systemctl', ['reload', 'apache2'], { stdio: 'pipe' });
}

// Restore a non-proxy placeholder vhost so the domain still serves something
// reasonable after the app is destroyed. Operator can edit afterwards.
function _writePlaceholderVhost(domain, docroot) {
  const confPath = path.join(SITES_AVAILABLE, `${domain}.conf`);
  const conf = `<VirtualHost *:80>
    ServerName ${domain}
    ServerAlias www.${domain}
    DocumentRoot ${docroot}
    ErrorLog \${APACHE_LOG_DIR}/${domain}_error.log
    CustomLog \${APACHE_LOG_DIR}/${domain}_access.log combined
    <Directory ${docroot}>
        Options -Indexes +FollowSymLinks
        AllowOverride All
        Require all granted
    </Directory>
</VirtualHost>
`;
  fs.writeFileSync(confPath, conf);
  try { execFileSync('apache2ctl', ['configtest'], { stdio: 'pipe' }); } catch (_) {}
  try { execFileSync('systemctl', ['reload', 'apache2'], { stdio: 'pipe' }); } catch (_) {}
}

// ── PM2 wrappers ──────────────────────────────────────────────────────────────
// PM2 takes care of restart-on-crash, log rotation, etc. We compose:
//   pm2 start <interpreter> --name <name> --cwd <docroot> -- <args...>
// Or for shell-style start commands, use `pm2 start bash --name <name> -- -c '<cmd>'`.
//
// We default to bash -c because it lets the operator write naturally
// ("npm start", "python app.py", "./run.sh"). Trade-off: an extra bash hop.

function _pm2Start(name, docroot, startCommand, port, env) {
  const fullEnv = {
    ...env,
    PORT: String(port),
    NODE_ENV: env?.NODE_ENV || 'production',
  };
  // Write a tiny launch script — pm2 + bash -c with arbitrary commands gets
  // messy with quoting. Script in /tmp eliminates the shell-escape question.
  const scriptPath = path.join('/tmp', `dpanel-app-${name}.sh`);
  const lines = [
    '#!/bin/bash',
    'set -e',
    `cd "${docroot}"`,
    ...Object.entries(fullEnv).map(([k, v]) => `export ${k}=${JSON.stringify(String(v))}`),
    `exec ${startCommand}`,
    '',
  ];
  fs.writeFileSync(scriptPath, lines.join('\n'));
  fs.chmodSync(scriptPath, 0o755);

  execFileSync('pm2', ['start', scriptPath, '--name', name, '--update-env'], { stdio: 'pipe' });
  execFileSync('pm2', ['save'], { stdio: 'pipe' });
}

function _pm2Delete(name) {
  try { execFileSync('pm2', ['delete', name], { stdio: 'pipe' }); } catch (_) {}
  try { execFileSync('pm2', ['save'], { stdio: 'pipe' }); } catch (_) {}
  try { fs.unlinkSync(path.join('/tmp', `dpanel-app-${name}.sh`)); } catch (_) {}
}

function _pm2Action(name, action) {
  // action ∈ {start, stop, restart}
  if (!['start', 'stop', 'restart'].includes(action)) throw new Error('Invalid PM2 action');
  execFileSync('pm2', [action, name], { stdio: 'pipe' });
}

// ── Public API ────────────────────────────────────────────────────────────────

async function listApps() {
  const [rows] = await pool.query('SELECT * FROM dpanel_apps ORDER BY name');
  return rows.map(r => ({
    ...r,
    env: r.env_json ? JSON.parse(r.env_json) : {},
    pm2: _pm2Status(r.name),
  }));
}

async function createApp({ name, domain, startCommand, runtime = 'node', env = {} }) {
  sanitizeAppName(name);
  sanitizeDomain(domain);
  if (!startCommand) throw new Error('Start command required');

  // Look up docroot from the existing vhost
  const vhosts = apache.listVhosts().filter(v => !v.domain.endsWith('-le-ssl'));
  const vhost  = vhosts.find(v => v.domain === domain);
  if (!vhost) throw new Error(`Domain ${domain} not found — provision it first`);
  const docroot = vhost.docRoot;

  // Defensive: refuse if this domain is already wired to another app
  const [[existing]] = await pool.query('SELECT name FROM dpanel_apps WHERE domain = ?', [domain]);
  if (existing) throw new Error(`Domain ${domain} is already running app "${existing.name}"`);

  const port = await _pickFreePort();

  // Order matters: PM2 first (so the port is listening before Apache proxies);
  // then Apache vhost; finally DB row. If anything mid-way fails, we attempt
  // a best-effort rollback.
  let pm2Started = false;
  try {
    _pm2Start(name, docroot, startCommand, port, env);
    pm2Started = true;
    _writeProxyVhost(domain, port);
    await pool.query(
      'INSERT INTO dpanel_apps (name, domain, docroot, start_command, port, env_json, runtime) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [name, domain, docroot, startCommand, port, Object.keys(env).length ? JSON.stringify(env) : null, runtime]
    );
    return { name, domain, port, docroot, runtime };
  } catch (err) {
    // Rollback
    if (pm2Started) _pm2Delete(name);
    // Vhost: if we replaced it, restore a placeholder
    _writePlaceholderVhost(domain, docroot);
    throw err;
  }
}

async function destroyApp(name) {
  sanitizeAppName(name);
  const [[row]] = await pool.query('SELECT * FROM dpanel_apps WHERE name = ?', [name]);
  if (!row) throw new Error('App not found');
  _pm2Delete(name);
  _writePlaceholderVhost(row.domain, row.docroot);
  await pool.query('DELETE FROM dpanel_apps WHERE id = ?', [row.id]);
  return { name, domain: row.domain };
}

async function controlApp(name, action) {
  sanitizeAppName(name);
  const [[row]] = await pool.query('SELECT 1 FROM dpanel_apps WHERE name = ?', [name]);
  if (!row) throw new Error('App not found');
  _pm2Action(name, action);
  return { name, action };
}

function getLogs(name, lines = 50) {
  sanitizeAppName(name);
  const cap = Math.min(Math.max(parseInt(lines, 10) || 50, 1), 500);
  const outFile = path.join(PM2_LOG_DIR, `${name}-out.log`);
  const errFile = path.join(PM2_LOG_DIR, `${name}-error.log`);
  const tail = (p) => {
    if (!fs.existsSync(p)) return '';
    try { return execFileSync('tail', ['-n', String(cap), p], { encoding: 'utf8' }); }
    catch (_) { return ''; }
  };
  return { stdout: tail(outFile), stderr: tail(errFile) };
}

module.exports = { listApps, createApp, destroyApp, controlApp, getLogs };
