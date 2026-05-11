'use strict';
/**
 * lib/domainhealth.js — Per-domain "is everything OK?" aggregator.
 *
 * Pulls a snapshot from every health-relevant subsystem we already maintain:
 *   • SSL cert (days remaining)
 *   • DNS (authoritative for the zone? does it resolve to us?)
 *   • Mail health (most-recent stored probe summary)
 *   • Backups (newest file + age)
 *   • Disk (docroot size)
 *   • PHP (version detected from vhost)
 *   • Apache error log tail (last 20 lines, error count last 24h)
 *
 * Returns a structured object suitable for both the per-domain detail modal
 * AND an at-a-glance summary on the Domains table.
 */

const fs       = require('fs');
const path     = require('path');
const dnsLib   = require('dns').promises;
const { execSync } = require('child_process');

const apache  = require('./apache');
const ssl     = require('./ssl');
const bind    = require('./dns');
const backup  = require('./backup');
const { pool } = require('./db');

const ERROR_LOG_LINES = 200;
const ERROR_LOG_WINDOW_MS = 24 * 60 * 60 * 1000;

function _serverIp() { return bind.SERVER_IP; }

async function _checkSSL(domain) {
  const certs = ssl.listCerts();
  const cert  = certs.find(c => c.domain === domain);
  if (!cert) return { status: 'fail', detail: 'No SSL cert found', daysLeft: null };
  if (cert.daysLeft == null)        return { status: 'warn', detail: 'Cert present but expiry unknown',  daysLeft: null,        issuer: cert.issuer };
  if (cert.daysLeft <= 3)           return { status: 'fail', detail: `Expires in ${cert.daysLeft} days`, daysLeft: cert.daysLeft, issuer: cert.issuer };
  if (cert.daysLeft <= 14)          return { status: 'warn', detail: `Expires in ${cert.daysLeft} days`, daysLeft: cert.daysLeft, issuer: cert.issuer };
  return { status: 'pass', detail: `${cert.daysLeft} days remaining`, daysLeft: cert.daysLeft, issuer: cert.issuer };
}

async function _checkDns(domain) {
  // Does the domain resolve to our IP?
  try {
    const ips = await Promise.race([
      dnsLib.resolve4(domain),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000)),
    ]);
    const expected = _serverIp();
    if (!ips.includes(expected)) {
      return { status: 'warn', detail: `Resolves to ${ips.join(',')}, expected ${expected}`, value: ips.join(',') };
    }
    return { status: 'pass', detail: `Resolves to ${expected}`, value: expected };
  } catch (err) {
    return { status: 'fail', detail: `DNS lookup failed: ${err.message}`, value: null };
  }
}

async function _checkMailHealth(domain) {
  try {
    const [[row]] = await pool.query(
      `SELECT summary, checked_at, result_json
         FROM dpanel_mail_health
         WHERE domain = ?
         ORDER BY checked_at DESC LIMIT 1`,
      [domain]
    );
    if (!row) return { status: 'skip', detail: 'No probe run yet — open Mail → Health' };
    // Parse the failures out of the JSON for a useful detail string
    let failedNames = [];
    try {
      const parsed = typeof row.result_json === 'string' ? JSON.parse(row.result_json) : row.result_json;
      failedNames = (parsed.checks || []).filter(c => c.status === 'fail').map(c => c.name);
    } catch (_) {}
    const detail = row.summary === 'pass'
      ? `Last probe: all clean (${new Date(row.checked_at).toLocaleString()})`
      : `${failedNames.length} check(s) failing: ${failedNames.join(', ')}`;
    return { status: row.summary, detail, lastChecked: row.checked_at };
  } catch (err) {
    return { status: 'skip', detail: 'Mail health not available' };
  }
}

async function _checkBackup(domain) {
  try {
    const all = backup.list();
    // Match any backup whose filename prefix matches this domain
    const mine = all.filter(b => b.file.startsWith(domain + '_'));
    if (!mine.length) return { status: 'warn', detail: 'No backups taken', latest: null };
    const newest = mine[0]; // backup.list() sorts newest first
    const ageMs  = Date.now() - new Date(newest.created).getTime();
    const days   = Math.floor(ageMs / 86400000);
    let status = 'pass';
    if (days >  7) status = 'warn';
    if (days > 30) status = 'fail';
    return {
      status,
      detail: `Newest: ${newest.file} (${days}d old, ${newest.sizeMb} MB)`,
      latest: { file: newest.file, ageDays: days, sizeMb: newest.sizeMb },
    };
  } catch (err) {
    return { status: 'skip', detail: err.message };
  }
}

function _checkDisk(domain, docRoot) {
  if (!docRoot || !fs.existsSync(docRoot)) return { status: 'skip', detail: 'No docroot' };
  try {
    const raw = execSync(`du -sb "${docRoot}" 2>/dev/null | cut -f1`, { encoding: 'utf8', timeout: 5000 }).trim();
    const bytes = parseInt(raw, 10) || 0;
    const mb    = +(bytes / 1024 / 1024).toFixed(1);
    return { status: 'pass', detail: `${mb} MB`, bytes, mb };
  } catch (err) {
    return { status: 'skip', detail: err.message };
  }
}

function _checkPhp(domain) {
  // Read the vhost; look for a SetHandler that names a php-fpm socket, or
  // a php<N>-fpm reference. Fall back to default Apache PHP if neither matches.
  try {
    const conf = apache.getVhostConfig(domain);
    const m = conf.match(/php(\d+(?:\.\d+)?)-fpm|php-fpm[^.]*\.([0-9.]+)/i);
    const v = m ? (m[1] || m[2]) : null;
    if (v) return { status: 'pass', detail: `PHP ${v}`, version: v };
    // Default Apache mod_php — figure out which is loaded
    const sys = execSync('a2query -m php 2>/dev/null || a2query -m php8.3 2>/dev/null || echo unknown', { encoding: 'utf8' }).trim();
    return { status: 'pass', detail: `Default (${sys || 'system'})`, version: 'default' };
  } catch (err) {
    return { status: 'skip', detail: 'Cannot detect PHP version' };
  }
}

function _checkErrorLog(domain) {
  const logFile = `/var/log/apache2/${domain}_error.log`;
  if (!fs.existsSync(logFile)) return { status: 'skip', detail: 'No error log yet', recentErrors: 0 };
  try {
    const tail = execSync(`tail -n ${ERROR_LOG_LINES} "${logFile}"`, { encoding: 'utf8', timeout: 3000 });
    const lines  = tail.split('\n').filter(l => /\[error\]|\[crit\]|\[alert\]|\[emerg\]/i.test(l));
    // Filter to lines from the last 24h. Apache log timestamp format: [Mon May 11 06:01:23.123456 2026]
    const cutoff = Date.now() - ERROR_LOG_WINDOW_MS;
    const recent = lines.filter(l => {
      const m = l.match(/^\[([^\]]+)\]/);
      if (!m) return false;
      const t = Date.parse(m[1]);
      return !isNaN(t) && t >= cutoff;
    });
    let status = 'pass';
    if (recent.length > 0)   status = 'warn';
    if (recent.length > 50)  status = 'fail';
    return {
      status,
      detail: recent.length ? `${recent.length} error(s) in last 24h` : 'No recent errors',
      recentErrors: recent.length,
      tail: lines.slice(-5),
    };
  } catch (err) {
    return { status: 'skip', detail: err.message };
  }
}

/**
 * Compute the overall health summary across all check results.
 * fail beats warn beats pass; skip never degrades the summary.
 */
function _summarize(checks) {
  const order = ['pass', 'skip', 'warn', 'fail'];
  let worst = 'pass';
  for (const k of Object.keys(checks)) {
    const s = checks[k]?.status;
    if (s && order.indexOf(s) > order.indexOf(worst)) worst = s === 'skip' ? worst : s;
  }
  return worst;
}

/**
 * Run all checks for one domain in parallel. Returns:
 *   { domain, summary, checks: { ssl, dns, mail, backup, disk, php, errors }, docRoot, checked_at }
 */
async function checkDomain(domain) {
  if (!domain) throw new Error('domain is required');

  // Resolve docroot once
  let docRoot = null;
  try {
    const vhosts = apache.listVhosts().filter(v => !v.domain.endsWith('-le-ssl'));
    const vhost  = vhosts.find(v => v.domain === domain);
    if (vhost) docRoot = vhost.docRoot;
  } catch (_) {}

  const [sslRes, dnsRes, mailRes, backupRes] = await Promise.all([
    _checkSSL(domain),
    _checkDns(domain),
    _checkMailHealth(domain),
    _checkBackup(domain),
  ]);
  const diskRes   = _checkDisk(domain, docRoot);
  const phpRes    = _checkPhp(domain);
  const errorRes  = _checkErrorLog(domain);

  const checks = { ssl: sslRes, dns: dnsRes, mail: mailRes, backup: backupRes, disk: diskRes, php: phpRes, errors: errorRes };
  return {
    domain,
    docRoot,
    summary:    _summarize(checks),
    checks,
    checked_at: new Date().toISOString(),
  };
}

module.exports = { checkDomain };
