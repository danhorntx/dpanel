'use strict';
/**
 * lib/postfix.js — Postfix per-domain SNI cert management.
 *
 * Postfix serves one global cert on the submission ports (587/465) unless
 * `tls_server_sni_maps` is configured. That map (built with `postmap -F`,
 * which bakes the PEM CONTENTS into the .db) lets Postfix present the right
 * mail.<domain> cert per SNI hostname — the submission-port equivalent of
 * Dovecot's `local_name` blocks.
 *
 * Mirrors lib/dovecot.js: register / unregister / reload. Each domain is a
 * single line in /etc/postfix/vmail_sni keyed by its mail.<domain> host:
 *
 *     mail.example.com  /etc/letsencrypt/live/mail.example.com/privkey.pem,/etc/letsencrypt/live/mail.example.com/fullchain.pem
 *
 * IMPORTANT: because `postmap -F` snapshots cert contents, the map MUST be
 * rebuilt whenever a cert renews. That's handled by the certbot deploy hook
 * at /etc/letsencrypt/renewal-hooks/deploy/reload-mail.sh.
 */

const fs           = require('fs');
const { execSync } = require('child_process');
const { sanitizeDomain, logAction } = require('./shell');

const SNI_MAP = '/etc/postfix/vmail_sni';
const MAIN_CF = '/etc/postfix/main.cf';
const HEADER  = '# DPanel-managed Postfix SNI map. postmap -F bakes cert\n'
              + '# contents into the .db; one line per mail.<domain> host.\n';

function _certPaths(domain) {
  const host = `mail.${domain}`;
  return {
    host,
    key:  `/etc/letsencrypt/live/${host}/privkey.pem`,
    cert: `/etc/letsencrypt/live/${host}/fullchain.pem`,
  };
}

/**
 * Ensure /etc/postfix/main.cf points tls_server_sni_maps at our map.
 * Idempotent. Returns true if it added the directive.
 */
function ensureMainCf() {
  const cf = fs.existsSync(MAIN_CF) ? fs.readFileSync(MAIN_CF, 'utf8') : '';
  if (/^\s*tls_server_sni_maps\s*=/m.test(cf)) return false;
  const add = `\n# DPanel per-domain SNI certs for submission (587/465)\n`
            + `tls_server_sni_maps = hash:${SNI_MAP}\n`;
  fs.appendFileSync(MAIN_CF, add);
  return true;
}

function _readMap() {
  if (!fs.existsSync(SNI_MAP)) return HEADER;
  return fs.readFileSync(SNI_MAP, 'utf8');
}

// Write the source map + rebuild the hashed .db (with -F to embed cert files).
function _writeAndRebuild(content) {
  const body = content.replace(/\n+$/, '') + '\n';
  fs.writeFileSync(SNI_MAP, body, { mode: 0o644 });
  execSync(`postmap -F hash:${SNI_MAP}`);
}

// Keep all comment/blank lines + every entry whose host != the given host.
function _withoutHost(content, host) {
  return content.split('\n').filter(line => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return true;
    return t.split(/\s+/)[0] !== host;
  });
}

/**
 * Register (or replace) the SNI entry for a domain. Idempotent.
 * Caller must ensure the mail.<domain> cert already exists.
 */
function registerSniDomain(domain) {
  sanitizeDomain(domain);
  const { host, key, cert } = _certPaths(domain);
  if (!fs.existsSync(cert) || !fs.existsSync(key)) {
    throw new Error(`Cert for ${host} not found at ${cert} — issue it first.`);
  }
  ensureMainCf();
  const lines = _withoutHost(_readMap(), host);
  lines.push(`${host}  ${key},${cert}`);
  _writeAndRebuild(lines.join('\n'));
  logAction('postfix:sni-register', host, 'ok');
}

/**
 * Remove a domain's SNI entry. Idempotent — silently succeeds if absent.
 */
function unregisterSniDomain(domain) {
  sanitizeDomain(domain);
  if (!fs.existsSync(SNI_MAP)) return;
  const { host } = _certPaths(domain);
  const before = _readMap();
  const after  = _withoutHost(before, host).join('\n');
  if (after.trim() === before.trim()) return;   // nothing to do
  _writeAndRebuild(after);
  logAction('postfix:sni-unregister', host, 'ok');
}

/**
 * Return the list of mail hosts currently registered in the SNI map.
 */
function listRegistered() {
  if (!fs.existsSync(SNI_MAP)) return [];
  return _readMap().split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
    .map(l => l.split(/\s+/)[0]);
}

/**
 * Validate + reload Postfix. Throws on config error so callers can react.
 */
function reload() {
  execSync('postfix check', { stdio: 'pipe' });
  execSync('systemctl reload postfix');
}

module.exports = { registerSniDomain, unregisterSniDomain, ensureMainCf, listRegistered, reload };
