'use strict';
const { execSync } = require('child_process');
const https = require('https');
const http  = require('http');
const { sanitizeDomain } = require('./shell');

// ── DNS resolution ────────────────────────────────────────────────────────────
function checkDns(domain) {
  try {
    const ip = execSync(`dig +short ${domain} A 2>/dev/null || host ${domain} 2>/dev/null | grep 'has address' | awk '{print $NF}'`, { encoding: 'utf8', timeout: 8000 }).trim().split('\n')[0];
    const serverIp = execSync("hostname -I | awk '{print $1}'", { encoding: 'utf8' }).trim();
    return { ok: !!ip, ip: ip || null, pointsHere: ip === serverIp };
  } catch (_) { return { ok: false, ip: null, pointsHere: false }; }
}

// ── HTTP fetch helper ─────────────────────────────────────────────────────────
function fetchHead(url, followRedirects = false) {
  return new Promise((resolve) => {
    const mod    = url.startsWith('https') ? https : http;
    const opts   = { method: 'HEAD', timeout: 8000, rejectUnauthorized: false };
    const req = mod.request(url, opts, (res) => {
      resolve({ status: res.statusCode, headers: res.headers, ok: res.statusCode < 400 });
    });
    req.on('error', (e) => resolve({ status: null, error: e.message, ok: false }));
    req.on('timeout', () => { req.destroy(); resolve({ status: null, error: 'timeout', ok: false }); });
    req.end();
  });
}

// ── SSL cert check ────────────────────────────────────────────────────────────
function checkSsl(domain) {
  try {
    const out = execSync(
      `echo | openssl s_client -connect ${domain}:443 -servername ${domain} 2>/dev/null | openssl x509 -noout -dates -subject 2>/dev/null`,
      { encoding: 'utf8', timeout: 10000 }
    );
    const expiry = out.match(/notAfter=(.+)/)?.[1]?.trim();
    const expiryDate = expiry ? new Date(expiry) : null;
    const daysLeft = expiryDate ? Math.ceil((expiryDate - Date.now()) / 86400000) : null;
    return { ok: true, expiry: expiry || null, daysLeft };
  } catch (_) { return { ok: false, expiry: null, daysLeft: null }; }
}

// ── Full health check ─────────────────────────────────────────────────────────
async function check(domain) {
  sanitizeDomain(domain);

  const dns = checkDns(domain);

  const [http80, https443] = await Promise.all([
    fetchHead(`http://${domain}`),
    fetchHead(`https://${domain}`),
  ]);

  // Check HTTP→HTTPS redirect
  const redirectsToHttps = http80.status >= 300 && http80.status < 400
    && (http80.headers?.location || '').startsWith('https');

  const ssl = checkSsl(domain);

  return {
    domain,
    dns,
    http:  { status: http80.status, ok: http80.ok },
    https: { status: https443.status, ok: https443.ok },
    redirect: { httpToHttps: redirectsToHttps },
    ssl,
    overall: dns.ok && https443.ok && ssl.ok,
  };
}

module.exports = { check, checkDns, checkSsl };
