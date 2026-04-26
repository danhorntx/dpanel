'use strict';
const fs   = require('fs');
const path = require('path');
const { run, runAsync, sanitizeDomain, sanitizePath } = require('./shell');

const LE_LIVE = '/etc/letsencrypt/live';

// ── listCerts ─────────────────────────────────────────────────────────────────
function listCerts() {
  const certs = [];
  if (fs.existsSync(LE_LIVE)) {
    const domains = fs.readdirSync(LE_LIVE);
    for (const domain of domains) {
      const certFile = path.join(LE_LIVE, domain, 'cert.pem');
      if (!fs.existsSync(certFile)) continue;
      try {
        const info = run(`openssl x509 -noout -subject -issuer -dates -in ${certFile}`, 'ssl:read-cert', domain);
        const expiry = info.match(/notAfter=(.+)/)?.[1]?.trim() || '';
        const issuer = info.match(/issuer=(.+)/)?.[1]?.trim() || '';
        const expiryDate = expiry ? new Date(expiry) : null;
        const daysLeft = expiryDate ? Math.ceil((expiryDate - Date.now()) / 86400000) : null;
        certs.push({ domain, issuer, expiry, daysLeft, type: "Let's Encrypt" });
      } catch (_) {}
    }
  }
  // Self-signed certs in /opt/dpanel/certs
  const selfDir = path.join(__dirname, '..', 'certs');
  if (fs.existsSync(selfDir)) {
    const files = fs.readdirSync(selfDir).filter(f => f.endsWith('.crt'));
    for (const file of files) {
      const domain = file.replace('.crt', '');
      const certFile = path.join(selfDir, file);
      try {
        const info = run(`openssl x509 -noout -subject -dates -in ${certFile}`, 'ssl:read-cert', domain);
        const expiry = info.match(/notAfter=(.+)/)?.[1]?.trim() || '';
        const expiryDate = expiry ? new Date(expiry) : null;
        const daysLeft = expiryDate ? Math.ceil((expiryDate - Date.now()) / 86400000) : null;
        certs.push({ domain, issuer: 'Self-signed', expiry, daysLeft, type: 'Self-signed' });
      } catch (_) {}
    }
  }
  return certs;
}

// ── requestCert — manual webroot mode ─────────────────────────────────────────
async function requestCert(domains, webroot) {
  sanitizePath(webroot);
  const domainList = domains.split(',').map(d => {
    sanitizeDomain(d.trim());
    return `-d ${d.trim()}`;
  }).join(' ');
  return runAsync(
    `certbot certonly --webroot -w ${webroot} ${domainList} --non-interactive --agree-tos --email admin@localhost`,
    'ssl:request', domains
  );
}

// ── isApexDomain — true only for root domains like example.com (not sub.example.com) ──
function isApexDomain(domain) {
  // Count dots: apex domains have exactly one dot (e.g. example.com)
  return (domain.match(/\./g) || []).length === 1;
}

// ── autoSSL — certbot --apache, called automatically on new domain creation ───
async function autoSSL(domain, email) {
  sanitizeDomain(domain);
  const safeEmail = (email || `admin@${domain}`).replace(/[^a-zA-Z0-9@._+-]/g, '');
  // Only add www. for apex domains — subdomains like sessions.example.com rarely have www.sessions.example.com
  const dFlags = isApexDomain(domain) ? `-d ${domain} -d www.${domain}` : `-d ${domain}`;
  return runAsync(
    `certbot --apache ${dFlags} --non-interactive --agree-tos --email ${safeEmail} --expand`,
    'ssl:auto', domain
  );
}

// ── renewCert — standard renewal (skips if not within 30-day window) ──────────
async function renewCert(domain) {
  sanitizeDomain(domain);
  return runAsync(`certbot renew --cert-name ${domain} --non-interactive`, 'ssl:renew', domain);
}

// ── renewAll ──────────────────────────────────────────────────────────────────
async function renewAll() {
  return runAsync('certbot renew --non-interactive', 'ssl:renew-all', 'all');
}

// ── reissueCert — force full reissue via certbot --apache ────────────────────
async function reissueCert(domain, email) {
  sanitizeDomain(domain);
  const safeEmail = (email || `admin@${domain}`).replace(/[^a-zA-Z0-9@._+-]/g, '');
  const dFlags = isApexDomain(domain) ? `-d ${domain} -d www.${domain}` : `-d ${domain}`;
  return runAsync(
    `certbot --apache ${dFlags} --non-interactive --agree-tos --email ${safeEmail} --force-renewal --expand`,
    'ssl:reissue', domain
  );
}

// ── revokeCert — delete cert + renewal config locally (no OCSP revoke) ───────
async function revokeCert(domain) {
  sanitizeDomain(domain);
  return runAsync(`certbot delete --cert-name ${domain} --non-interactive`, 'ssl:delete', domain);
}

module.exports = { listCerts, requestCert, autoSSL, renewCert, renewAll, reissueCert, revokeCert };
