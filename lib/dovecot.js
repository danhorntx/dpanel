'use strict';
/**
 * lib/dovecot.js — Manages Dovecot SNI configuration.
 *
 * Dovecot supports per-hostname TLS via `local_name` blocks in its config.
 * DPanel owns a single file (/etc/dovecot/conf.d/95-dpanel-sni.conf) where
 * one block is appended per mail-enabled domain. Each block points Dovecot
 * at the Let's Encrypt cert for `mail.<domain>`.
 *
 * When an IMAP client connects with SNI matching one of the registered
 * hostnames, Dovecot serves the corresponding cert. Otherwise it falls
 * back to the global ssl_cert/ssl_key defined in 10-ssl.conf (or, on prod,
 * in dovecot.conf itself, which takes precedence — see HANDOFF.md gotcha).
 *
 * The file is filename-sorted to load after 10-ssl.conf so our blocks
 * override the default for matching SNI hostnames.
 *
 * Block delimiters use the same begin/end comment pattern the redirect
 * manager uses on .htaccess so registration is idempotent and removals
 * are clean even on a file edited by hand.
 */

const fs = require('fs');
const path = require('path');
const { run, sanitizeDomain } = require('./shell');

const SNI_FILE   = '/etc/dovecot/conf.d/95-dpanel-sni.conf';
const HEADER     = '# DPanel-managed Dovecot SNI configuration — generated, do not edit manually.\n# Each block points at a per-domain mail.<domain> Let\'s Encrypt cert.\n\n';

function _beginMarker(domain) { return `# BEGIN dpanel-sni domain=${domain}`; }
function _endMarker(domain)   { return `# END dpanel-sni domain=${domain}`; }

function _ensureFile() {
  if (!fs.existsSync(SNI_FILE)) {
    fs.writeFileSync(SNI_FILE, HEADER, { mode: 0o644 });
  }
}

function _readFile() {
  _ensureFile();
  return fs.readFileSync(SNI_FILE, 'utf8');
}

function _writeFile(content) {
  fs.writeFileSync(SNI_FILE, content, { mode: 0o644 });
}

// Strip an existing block (idempotent).
function _stripBlock(content, domain) {
  const begin = _beginMarker(domain);
  const end   = _endMarker(domain);
  const startIdx = content.indexOf(begin);
  if (startIdx === -1) return content;
  const endIdx = content.indexOf(end, startIdx);
  if (endIdx === -1) return content; // malformed — leave as-is, don't make it worse
  const afterEnd = endIdx + end.length;
  // Also consume the trailing newline if present so we don't accumulate blank lines
  const cut = content.charAt(afterEnd) === '\n' ? afterEnd + 1 : afterEnd;
  return content.slice(0, startIdx) + content.slice(cut);
}

/**
 * Register a per-domain Dovecot SNI block. Idempotent — replaces any
 * existing block for the same domain.
 *
 * @param {string} domain — e.g. "example.com"; the cert is expected at
 *                          /etc/letsencrypt/live/mail.example.com/
 */
function registerLocalName(domain) {
  sanitizeDomain(domain);
  const mailHost = `mail.${domain}`;
  const certPath = `/etc/letsencrypt/live/${mailHost}/fullchain.pem`;
  const keyPath  = `/etc/letsencrypt/live/${mailHost}/privkey.pem`;

  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
    throw new Error(`Cert for ${mailHost} not found at ${certPath} — issue it first.`);
  }

  let content = _readFile();
  content = _stripBlock(content, domain);
  const block =
`${_beginMarker(domain)}
local_name ${mailHost} {
  ssl_cert = <${certPath}
  ssl_key  = <${keyPath}
}
${_endMarker(domain)}
`;
  // Preserve trailing newline structure: ensure header end has a blank line, then append.
  if (!content.endsWith('\n')) content += '\n';
  _writeFile(content + block);
}

/**
 * Remove the SNI block for a domain. Idempotent — silently succeeds
 * if no block exists.
 */
function unregisterLocalName(domain) {
  sanitizeDomain(domain);
  if (!fs.existsSync(SNI_FILE)) return;
  const content = _readFile();
  const stripped = _stripBlock(content, domain);
  if (stripped !== content) _writeFile(stripped);
}

/**
 * Return the list of domains currently registered for SNI.
 */
function listRegistered() {
  if (!fs.existsSync(SNI_FILE)) return [];
  const content = fs.readFileSync(SNI_FILE, 'utf8');
  const out = [];
  for (const m of content.matchAll(/^# BEGIN dpanel-sni domain=(.+)$/gm)) out.push(m[1].trim());
  return out;
}

/**
 * Validate Dovecot config + reload. Throws on config error so callers can
 * roll back a registration that produced an invalid config.
 */
function reload() {
  // doveconf returns non-zero on syntax errors
  run('doveconf -n > /dev/null', 'dovecot:configtest', 'sni');
  run('systemctl reload dovecot', 'dovecot:reload', 'sni');
}

module.exports = { registerLocalName, unregisterLocalName, listRegistered, reload };
