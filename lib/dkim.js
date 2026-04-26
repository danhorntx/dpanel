'use strict';
const fs   = require('fs');
const path = require('path');
const { run, runAsync, sanitizeDomain } = require('./shell');

const KEYS_DIR      = '/etc/opendkim/keys';
const KEY_TABLE     = '/etc/opendkim/KeyTable';
const SIGNING_TABLE = '/etc/opendkim/SigningTable';
const SELECTOR      = 'mail';

// ── Ensure OpenDKIM dirs exist ────────────────────────────────────────────────
function ensureDirs() {
  if (!fs.existsSync(KEYS_DIR)) fs.mkdirSync(KEYS_DIR, { recursive: true });
}

// ── Generate DKIM key pair for a domain ───────────────────────────────────────
async function generateKey(domain) {
  sanitizeDomain(domain);
  ensureDirs();
  const domainDir = path.join(KEYS_DIR, domain);
  if (!fs.existsSync(domainDir)) fs.mkdirSync(domainDir, { recursive: true });

  // Generate 2048-bit RSA key pair
  await runAsync(
    `opendkim-genkey -b 2048 -d ${domain} -D ${domainDir} -s ${SELECTOR} -v`,
    'dkim:genkey', domain
  );
  // Set correct ownership
  try { run(`chown -R opendkim:opendkim ${domainDir}`, 'dkim:chown', domain); } catch (_) {}

  // Append to KeyTable (idempotent: remove old entry first)
  _removeFromFile(KEY_TABLE, domain);
  const keyEntry = `${SELECTOR}._domainkey.${domain} ${domain}:${SELECTOR}:${domainDir}/${SELECTOR}.private\n`;
  fs.appendFileSync(KEY_TABLE, keyEntry);

  // Append to SigningTable (idempotent)
  _removeFromFile(SIGNING_TABLE, domain);
  const signEntry = `*@${domain} ${SELECTOR}._domainkey.${domain}\n`;
  fs.appendFileSync(SIGNING_TABLE, signEntry);

  // Reload OpenDKIM
  try { run('systemctl reload opendkim', 'dkim:reload', domain); } catch (_) {}

  return getPublicKey(domain);
}

// ── Read public key TXT record value ─────────────────────────────────────────
function getPublicKey(domain) {
  sanitizeDomain(domain);
  const txtFile = path.join(KEYS_DIR, domain, `${SELECTOR}.txt`);
  if (!fs.existsSync(txtFile)) return null;
  const content = fs.readFileSync(txtFile, 'utf8');
  // Extract the p= value from the TXT record
  const match = content.match(/p=([A-Za-z0-9+/=]+)/);
  return match ? `v=DKIM1; k=rsa; p=${match[1]}` : content;
}

// ── Check if a domain has DKIM configured ────────────────────────────────────
function hasDkim(domain) {
  sanitizeDomain(domain);
  return fs.existsSync(path.join(KEYS_DIR, domain, `${SELECTOR}.private`));
}

// ── Remove a domain from OpenDKIM tables ─────────────────────────────────────
function removeKey(domain) {
  sanitizeDomain(domain);
  _removeFromFile(KEY_TABLE, domain);
  _removeFromFile(SIGNING_TABLE, domain);
  const domainDir = path.join(KEYS_DIR, domain);
  if (fs.existsSync(domainDir)) {
    fs.rmSync(domainDir, { recursive: true, force: true });
  }
  try { run('systemctl reload opendkim', 'dkim:reload', domain); } catch (_) {}
}

// ── Build full DNS records needed for email ───────────────────────────────────
function getDnsRecords(domain, serverIp) {
  sanitizeDomain(domain);
  const records = [
    { type: 'MX',  name: domain,                      value: `mail.${domain}`,  priority: 10,  purpose: 'Mail server' },
    { type: 'A',   name: `mail.${domain}`,             value: serverIp,          priority: null, purpose: 'Mail server IP' },
    { type: 'TXT', name: domain,                       value: `v=spf1 mx a ip4:${serverIp} ~all`, priority: null, purpose: 'SPF (spam prevention)' },
    { type: 'TXT', name: `_dmarc.${domain}`,           value: `v=DMARC1; p=quarantine; rua=mailto:dmarc@${domain}`, priority: null, purpose: 'DMARC policy' },
  ];
  if (hasDkim(domain)) {
    const dkimVal = getPublicKey(domain);
    if (dkimVal) {
      records.push({ type: 'TXT', name: `${SELECTOR}._domainkey.${domain}`, value: dkimVal, priority: null, purpose: 'DKIM signature' });
    }
  }
  return records;
}

// ── Verify DNS records via dig ────────────────────────────────────────────────
async function verifyDns(domain) {
  sanitizeDomain(domain);
  const results = {};
  const checks = [
    { key: 'mx',   cmd: `dig +short MX ${domain}` },
    { key: 'spf',  cmd: `dig +short TXT ${domain}` },
    { key: 'dkim', cmd: `dig +short TXT ${SELECTOR}._domainkey.${domain}` },
    { key: 'dmarc',cmd: `dig +short TXT _dmarc.${domain}` },
  ];
  for (const { key, cmd } of checks) {
    try {
      const out = await runAsync(cmd, 'dkim:verify', domain);
      results[key] = { ok: out.trim().length > 0, value: out.trim() };
    } catch (_) {
      results[key] = { ok: false, value: '' };
    }
  }
  return results;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function _removeFromFile(filePath, domain) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  const filtered = lines.filter(l => !l.includes(domain));
  fs.writeFileSync(filePath, filtered.join('\n'));
}

module.exports = { generateKey, getPublicKey, hasDkim, removeKey, getDnsRecords, verifyDns };
