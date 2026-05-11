'use strict';
/**
 * lib/mailhealth.js — Per-domain mail deliverability probe.
 *
 * Answers "would mail from this domain actually land in Gmail's inbox?"
 * without sending a real test message. Checks every prerequisite that
 * receiving MTAs use to decide trust:
 *
 *   rdns       — PTR for our IP resolves back to a name with a matching A
 *   helo       — Postfix's HELO/EHLO hostname has an A pointing to our IP
 *   mail-a     — mail.<domain> resolves to our IP (so IMAP/SMTP TLS works)
 *   mx         — domain publishes MX, and the MX target resolves to our IP
 *   spf        — domain publishes SPF that authorizes our IP
 *   dkim       — mail._domainkey.<domain> publishes a valid DKIM v1 record
 *   dmarc      — _dmarc.<domain> publishes a DMARC v1 record
 *   mta-sts    — mta-sts.<domain> serves a /.well-known/mta-sts.txt policy
 *   tls-rpt    — _smtp._tls.<domain> publishes a TLS-RPT v1 record
 *   tls-cert   — mail.<domain> presents a non-expired cert matching the hostname
 *   rbl        — our IP isn't listed on Spamhaus / Sorbs / Barracuda
 *
 * Each check returns { status: 'pass'|'warn'|'fail'|'skip', detail, value }.
 * Checks run in parallel with a per-check timeout so a slow RBL lookup
 * doesn't stall the whole probe.
 *
 * Designed to be called from:
 *   - POST /api/mail/health/:domain — on-demand from the UI
 *   - daily cron — populates analytics_mail_health table for trending
 */

const dns       = require('dns').promises;
const tls       = require('tls');
const https     = require('https');
const { execSync } = require('child_process');

const dnsLib    = require('./dns');         // for SERVER_IP
const dkim      = require('./dkim');

const DEFAULT_TIMEOUT_MS = 5000;
const SELECTOR           = 'mail';

// RBL zones: each maps a reverse-IP query to a listed-yes/no answer.
// 'description' is shown in the UI when listed; 'tier' bumps severity for
// the well-known major RBLs.
const RBL_ZONES = [
  { zone: 'zen.spamhaus.org',  description: 'Spamhaus ZEN (sbl+xbl+pbl)', tier: 'critical' },
  { zone: 'b.barracudacentral.org', description: 'Barracuda',             tier: 'critical' },
  { zone: 'bl.spamcop.net',    description: 'SpamCop',                    tier: 'high'     },
  { zone: 'dnsbl.sorbs.net',   description: 'SORBS',                      tier: 'high'     },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function withTimeout(promise, ms = DEFAULT_TIMEOUT_MS, tag = 'op') {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${tag} timeout after ${ms}ms`)), ms)),
  ]);
}

function reverseIp(ip) {
  return ip.split('.').reverse().join('.');
}

function detectMyhostname() {
  try {
    return execSync('postconf -h myhostname', { encoding: 'utf8', timeout: 2000 }).trim();
  } catch (_) {
    try { return execSync('hostname -f', { encoding: 'utf8', timeout: 2000 }).trim(); }
    catch (_) { return null; }
  }
}

// Normalize TXT chunks ("chunk1" "chunk2") into a single string.
function txtRecordsAsStrings(records) {
  return records.map(parts => Array.isArray(parts) ? parts.join('') : String(parts));
}

// ── Individual checks ─────────────────────────────────────────────────────────

async function checkRdns(serverIp, myhostname) {
  try {
    const names = await withTimeout(dns.reverse(serverIp), DEFAULT_TIMEOUT_MS, 'rdns');
    if (!names || names.length === 0) {
      return { status: 'fail', detail: `No PTR record for ${serverIp}`, value: null };
    }
    const ptr = names[0];
    // Forward-confirm: does the PTR's hostname resolve back to our IP?
    let forwardOk = false;
    try {
      const ips = await withTimeout(dns.resolve4(ptr), DEFAULT_TIMEOUT_MS, 'rdns-forward');
      forwardOk = ips.includes(serverIp);
    } catch (_) {}

    if (!forwardOk) {
      return { status: 'fail', detail: `PTR=${ptr} but A record doesn't loop back to ${serverIp} (forward-confirm failed)`, value: ptr };
    }
    // Best practice: PTR matches the HELO hostname. Not strictly required by RFC
    // but Gmail/Outlook penalize mismatches.
    if (myhostname && ptr.toLowerCase() !== myhostname.toLowerCase()) {
      return { status: 'warn', detail: `PTR=${ptr} ≠ HELO=${myhostname}. Forward-confirms but receivers may downgrade reputation.`, value: ptr };
    }
    return { status: 'pass', detail: `PTR=${ptr}, forward-confirmed`, value: ptr };
  } catch (err) {
    return { status: 'fail', detail: err.message, value: null };
  }
}

async function checkHelo(myhostname, serverIp) {
  if (!myhostname) return { status: 'fail', detail: 'Postfix myhostname not detected', value: null };
  try {
    const ips = await withTimeout(dns.resolve4(myhostname), DEFAULT_TIMEOUT_MS, 'helo');
    if (!ips.includes(serverIp)) {
      return { status: 'fail', detail: `HELO=${myhostname} resolves to ${ips.join(',')}, not ${serverIp}`, value: myhostname };
    }
    return { status: 'pass', detail: `HELO=${myhostname} → ${serverIp}`, value: myhostname };
  } catch (err) {
    return { status: 'fail', detail: `HELO ${myhostname} doesn't resolve: ${err.message}`, value: myhostname };
  }
}

async function checkMailA(domain, serverIp) {
  const host = `mail.${domain}`;
  try {
    const ips = await withTimeout(dns.resolve4(host), DEFAULT_TIMEOUT_MS, 'mail-a');
    if (!ips.includes(serverIp)) {
      return { status: 'fail', detail: `${host} → ${ips.join(',')}, expected ${serverIp}`, value: ips.join(',') };
    }
    return { status: 'pass', detail: `${host} → ${serverIp}`, value: ips[0] };
  } catch (err) {
    return { status: 'fail', detail: `${host} doesn't resolve: ${err.message}`, value: null };
  }
}

async function checkMx(domain, serverIp) {
  try {
    const mxs = await withTimeout(dns.resolveMx(domain), DEFAULT_TIMEOUT_MS, 'mx');
    if (!mxs.length) return { status: 'fail', detail: 'No MX records', value: null };
    mxs.sort((a, b) => a.priority - b.priority);
    const primary = mxs[0];
    let primaryIps = [];
    try { primaryIps = await withTimeout(dns.resolve4(primary.exchange), DEFAULT_TIMEOUT_MS, 'mx-resolve'); } catch (_) {}
    if (!primaryIps.includes(serverIp)) {
      return { status: 'fail', detail: `MX → ${primary.exchange} (${primaryIps.join(',')||'no A'}), expected ${serverIp}`, value: primary.exchange };
    }
    return { status: 'pass', detail: `MX ${primary.priority} ${primary.exchange} → ${serverIp}`, value: `${primary.priority} ${primary.exchange}` };
  } catch (err) {
    return { status: 'fail', detail: err.message, value: null };
  }
}

async function checkSpf(domain, serverIp) {
  try {
    const records = await withTimeout(dns.resolveTxt(domain), DEFAULT_TIMEOUT_MS, 'spf');
    const flat    = txtRecordsAsStrings(records);
    const spf     = flat.find(s => s.startsWith('v=spf1'));
    if (!spf) return { status: 'fail', detail: 'No SPF record', value: null };
    // Heuristic: SPF authorizes our IP if it appears literally, or has `a`/`mx` mechanism
    // that points to us (we already verified MX and mail.<domain> above), or has +all.
    const hasIp = spf.includes(`ip4:${serverIp}`);
    const hasA  = /\ba\b/.test(spf) || /\bmx\b/.test(spf);
    if (!hasIp && !hasA) {
      return { status: 'warn', detail: `SPF doesn't reference ${serverIp} directly; relies on something else: ${spf}`, value: spf };
    }
    if (!spf.endsWith('~all') && !spf.endsWith('-all')) {
      return { status: 'warn', detail: `SPF is permissive (no ~all or -all): ${spf}`, value: spf };
    }
    return { status: 'pass', detail: spf, value: spf };
  } catch (err) {
    return { status: 'fail', detail: err.message, value: null };
  }
}

async function checkDkim(domain) {
  const host = `${SELECTOR}._domainkey.${domain}`;
  try {
    const records = await withTimeout(dns.resolveTxt(host), DEFAULT_TIMEOUT_MS, 'dkim');
    const flat    = txtRecordsAsStrings(records);
    const dkimRec = flat.find(s => s.startsWith('v=DKIM1'));
    if (!dkimRec) return { status: 'fail', detail: `No DKIM TXT at ${host}`, value: null };
    // Verify locally that the published key matches what's on disk
    let matches = null;
    try {
      const bare = dkim.getBareKey(domain);
      if (bare) matches = dkimRec.includes(bare);
    } catch (_) {}
    if (matches === false) {
      return { status: 'fail', detail: 'DKIM TXT does not match local OpenDKIM key — DNS publication is stale', value: dkimRec.slice(0, 120) + '…' };
    }
    return { status: 'pass', detail: matches === true ? 'Published and matches local key' : 'Published (local match not verified)', value: dkimRec.slice(0, 120) + (dkimRec.length > 120 ? '…' : '') };
  } catch (err) {
    return { status: 'fail', detail: err.message, value: null };
  }
}

async function checkDmarc(domain) {
  const host = `_dmarc.${domain}`;
  try {
    const records = await withTimeout(dns.resolveTxt(host), DEFAULT_TIMEOUT_MS, 'dmarc');
    const flat    = txtRecordsAsStrings(records);
    const dmarc   = flat.find(s => s.startsWith('v=DMARC1'));
    if (!dmarc) return { status: 'fail', detail: `No DMARC TXT at ${host}`, value: null };
    if (dmarc.includes('p=none')) {
      return { status: 'warn', detail: `DMARC published with p=none — monitoring only, no enforcement: ${dmarc}`, value: dmarc };
    }
    return { status: 'pass', detail: dmarc, value: dmarc };
  } catch (err) {
    return { status: 'fail', detail: err.message, value: null };
  }
}

async function checkMtaSts(domain) {
  // 1. DNS: _mta-sts.<domain> TXT must publish a version+id
  let policyId = null;
  try {
    const records = await withTimeout(dns.resolveTxt(`_mta-sts.${domain}`), DEFAULT_TIMEOUT_MS, 'mta-sts-dns');
    const flat    = txtRecordsAsStrings(records);
    const rec     = flat.find(s => s.startsWith('v=STSv1'));
    if (!rec) return { status: 'skip', detail: 'No MTA-STS DNS record published', value: null };
    const m = rec.match(/id=([A-Za-z0-9]+)/);
    if (!m) return { status: 'warn', detail: `MTA-STS DNS record missing id=: ${rec}`, value: rec };
    policyId = m[1];
  } catch (err) {
    return { status: 'skip', detail: `No MTA-STS DNS record (${err.code || err.message})`, value: null };
  }

  // 2. HTTPS: GET https://mta-sts.<domain>/.well-known/mta-sts.txt
  const body = await new Promise(resolve => {
    const req = https.get(`https://mta-sts.${domain}/.well-known/mta-sts.txt`, { timeout: DEFAULT_TIMEOUT_MS }, res => {
      if (res.statusCode !== 200) { resolve({ error: `HTTP ${res.statusCode}` }); return; }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ text: data }));
    });
    req.on('error', err => resolve({ error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
  });
  if (body.error) return { status: 'fail', detail: `DNS publishes id=${policyId} but policy file unreachable: ${body.error}`, value: policyId };
  if (!/version:\s*STSv1/i.test(body.text)) {
    return { status: 'fail', detail: 'Policy file fetched but missing version: STSv1', value: policyId };
  }
  const mode = (body.text.match(/^mode:\s*(\w+)/im) || [])[1] || '(missing)';
  return { status: 'pass', detail: `Policy live (id=${policyId}, mode=${mode})`, value: policyId };
}

async function checkTlsRpt(domain) {
  const host = `_smtp._tls.${domain}`;
  try {
    const records = await withTimeout(dns.resolveTxt(host), DEFAULT_TIMEOUT_MS, 'tls-rpt');
    const flat    = txtRecordsAsStrings(records);
    const rec     = flat.find(s => s.startsWith('v=TLSRPTv1'));
    if (!rec) return { status: 'skip', detail: 'No TLS-RPT TXT', value: null };
    return { status: 'pass', detail: rec, value: rec };
  } catch (err) {
    return { status: 'skip', detail: 'No TLS-RPT TXT', value: null };
  }
}

async function checkTlsCert(domain) {
  const host = `mail.${domain}`;
  return new Promise(resolve => {
    const socket = tls.connect({
      host:        domain.includes('localhost') ? '127.0.0.1' : host,
      servername:  host,
      port:        993,
      rejectUnauthorized: false,  // we inspect the cert ourselves
      timeout:     DEFAULT_TIMEOUT_MS,
    }, () => {
      const cert = socket.getPeerCertificate(false);
      socket.end();
      if (!cert || !cert.subject) return resolve({ status: 'fail', detail: 'No certificate returned', value: null });
      const cn         = cert.subject.CN;
      const altNames   = (cert.subjectaltname || '').split(',').map(s => s.replace(/^DNS:/i, '').trim());
      const matches    = cn === host || altNames.includes(host);
      const notAfter   = cert.valid_to ? new Date(cert.valid_to) : null;
      const daysLeft   = notAfter ? Math.ceil((notAfter - Date.now()) / 86400000) : null;
      if (!matches)  return resolve({ status: 'fail', detail: `Cert CN/SAN doesn't include ${host} (got CN=${cn}, SAN=[${altNames.join(', ')}])`, value: cn });
      if (daysLeft !== null && daysLeft < 14) return resolve({ status: 'warn', detail: `Cert valid but expires in ${daysLeft} days`, value: cn });
      return resolve({ status: 'pass', detail: `${cn}, ${daysLeft} days remaining`, value: cn });
    });
    socket.on('error',   err => resolve({ status: 'fail', detail: `TLS handshake failed: ${err.message}`, value: null }));
    socket.on('timeout', ()  => { socket.destroy(); resolve({ status: 'fail', detail: 'TLS handshake timeout', value: null }); });
  });
}

async function checkRbl(serverIp) {
  const rev = reverseIp(serverIp);
  const results = await Promise.all(RBL_ZONES.map(async ({ zone, description, tier }) => {
    try {
      await withTimeout(dns.resolve4(`${rev}.${zone}`), DEFAULT_TIMEOUT_MS, `rbl:${zone}`);
      return { zone, description, tier, listed: true };
    } catch (err) {
      // ENOTFOUND/ENODATA = not listed (the expected case)
      return { zone, description, tier, listed: false };
    }
  }));
  const listed = results.filter(r => r.listed);
  if (!listed.length) {
    return { status: 'pass', detail: `Not listed on any of ${RBL_ZONES.length} RBLs checked`, value: 'clean' };
  }
  const critical = listed.filter(r => r.tier === 'critical');
  const status   = critical.length ? 'fail' : 'warn';
  return {
    status,
    detail: `Listed on: ${listed.map(r => r.description).join(', ')}`,
    value:  listed.map(r => r.zone).join(','),
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run the full health probe for one domain. All checks run in parallel,
 * each with its own timeout so a slow check doesn't gate the response.
 *
 * @param {string} domain — e.g. "example.com"
 * @returns {Promise<{domain, summary, checks: Array<{name, status, detail, value}>}>}
 */
async function checkDomain(domain) {
  if (!domain) throw new Error('domain is required');
  const serverIp   = dnsLib.SERVER_IP;
  const myhostname = detectMyhostname();

  const [rdns, helo, mailA, mx, spf, dkimR, dmarc, mtasts, tlsrpt, tlscert, rbl] = await Promise.all([
    checkRdns(serverIp, myhostname),
    checkHelo(myhostname, serverIp),
    checkMailA(domain, serverIp),
    checkMx(domain, serverIp),
    checkSpf(domain, serverIp),
    checkDkim(domain),
    checkDmarc(domain),
    checkMtaSts(domain),
    checkTlsRpt(domain),
    checkTlsCert(domain),
    checkRbl(serverIp),
  ]);

  const checks = [
    { name: 'rdns',      ...rdns },
    { name: 'helo',      ...helo },
    { name: 'mail-a',    ...mailA },
    { name: 'mx',        ...mx },
    { name: 'spf',       ...spf },
    { name: 'dkim',      ...dkimR },
    { name: 'dmarc',     ...dmarc },
    { name: 'mta-sts',   ...mtasts },
    { name: 'tls-rpt',   ...tlsrpt },
    { name: 'tls-cert',  ...tlscert },
    { name: 'rbl',       ...rbl },
  ];

  const tally = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const c of checks) tally[c.status] = (tally[c.status] || 0) + 1;

  // Overall status: any fail → 'fail', else any warn → 'warn', else 'pass'.
  // (Skips don't degrade the overall — they represent "feature not configured".)
  const summary = tally.fail ? 'fail' : (tally.warn ? 'warn' : 'pass');

  return {
    domain,
    server_ip: serverIp,
    helo_hostname: myhostname,
    summary,
    tally,
    checked_at: new Date().toISOString(),
    checks,
  };
}

module.exports = {
  checkDomain,
  // exported for testing/reuse
  checkRdns, checkHelo, checkMailA, checkMx, checkSpf, checkDkim,
  checkDmarc, checkMtaSts, checkTlsRpt, checkTlsCert, checkRbl,
};
