'use strict';
const express    = require('express');
const crypto     = require('crypto');
const { execSync } = require('child_process');
const fs         = require('fs');
const path       = require('path');
const apache     = require('../lib/apache');
const { createAccount } = require('../lib/access');
const ssl        = require('../lib/ssl');
const dns        = require('../lib/dns');
const { pool }   = require('../lib/db');
const router     = express.Router();

const CONFIG_FILE = path.join(__dirname, '..', 'config.json');

// ── Helpers ───────────────────────────────────────────────────────────────────
function generatePassword(len = 20) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from(crypto.randomBytes(len)).map(b => chars[b % chars.length]).join('');
}

// danhorntx.com → danhorntx_deploy  |  sub.danhorntx.com → subdanhorntx_deploy
function deriveUsername(domain) {
  const base = domain
    .replace(/\.[^.]+$/, '')   // strip TLD
    .replace(/\./g, '')         // collapse subdomains
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase()
    .slice(0, 24);              // keep username sane length
  return (base || 'site') + '_deploy';
}

function getServerIp() {
  try { return execSync("hostname -I | awk '{print $1}'", { encoding: 'utf8' }).trim(); }
  catch (_) { return ''; }
}

function getAdminEmail() {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return config.adminEmail || null;
  } catch (_) { return null; }
}

/**
 * For a subdomain like sub.danhorntx.com, walk up the label hierarchy to find
 * the nearest parent that has a BIND zone managed by DPanel.
 *
 * Returns { parentDomain, subdomain } or null if this is an apex domain.
 *
 * Examples:
 *   preview.danhorntx.com  → { parentDomain:'danhorntx.com', subdomain:'preview' }
 *   a.b.danhorntx.com      → { parentDomain:'danhorntx.com', subdomain:'a.b' }
 *   danhorntx.com          → null
 */
function findParentZone(domain) {
  const parts = domain.split('.');
  // Need at least 3 labels to be a subdomain (sub.example.com)
  if (parts.length < 3) return null;
  // Try each progressively shorter suffix as a potential parent zone
  for (let i = 1; i < parts.length - 1; i++) {
    const candidate = parts.slice(i).join('.');
    if (dns.zoneExists(candidate)) {
      const subdomain = parts.slice(0, i).join('.');
      return { parentDomain: candidate, subdomain };
    }
  }
  return null;
}

/**
 * Provision DNS for a newly-added domain:
 *
 *   Subdomain (parent zone exists) → add A record to parent zone
 *   Apex domain / no parent found  → create a full zone
 *
 * Returns a descriptor of what was done so the caller can include it in the
 * response and (if needed) undo it on error.
 *
 * Never throws — DNS is always treated as best-effort.
 */
function provisionDns(domain, ip) {
  try {
    const parent = findParentZone(domain);
    if (parent) {
      // Subdomain — inject A record into existing parent zone
      dns.addRecord(parent.parentDomain, {
        name:  parent.subdomain,
        ttl:   14400,
        type:  'A',
        value: ip,
      });
      return { action: 'record_added', parentDomain: parent.parentDomain, subdomain: parent.subdomain, ip };
    } else {
      // Apex domain — create full zone if it doesn't exist yet
      if (!dns.zoneExists(domain)) {
        dns.createZone(domain, ip);
        return { action: 'zone_created', domain, ip };
      }
      return { action: 'zone_exists', domain };
    }
  } catch (err) {
    console.error('[domains] DNS provisioning error for', domain, ':', err.message);
    return { action: 'failed', error: err.message };
  }
}

/**
 * Clean up DNS when a domain/subdomain vhost is deleted:
 *
 *   Subdomain → remove the A record from the parent zone
 *   Apex      → leave the zone intact (user may have custom records; they can
 *               delete it explicitly via DNS Manager)
 *
 * Never throws.
 */
function deprovisionDns(domain) {
  try {
    const parent = findParentZone(domain);
    if (parent) {
      dns.deleteRecord(parent.parentDomain, { name: parent.subdomain, type: 'A' });
      return { action: 'record_removed', parentDomain: parent.parentDomain, subdomain: parent.subdomain };
    }
    // Apex domains: DNS zone left in place intentionally
    return { action: 'skipped', reason: 'apex domain — zone preserved' };
  } catch (err) {
    console.error('[domains] DNS deprovision error for', domain, ':', err.message);
    return { action: 'failed', error: err.message };
  }
}

// ── GET /api/domains ──────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  try {
    const HIDDEN_SUFFIXES = ['-le-ssl', '000-default', 'default-ssl'];
    const HIDDEN_PREFIXES = ['autoconfig.', 'autodiscover.', 'webmail.'];
    const vhosts = apache.listVhosts().filter(v =>
      !HIDDEN_SUFFIXES.some(h => v.domain.endsWith(h)) &&
      !HIDDEN_PREFIXES.some(h => v.domain.startsWith(h))
    );
    res.json({ success: true, data: vhosts });
  }
  catch (err) { res.json({ success: false, error: err.message }); }
});

// ── POST /api/domains — create vhost + SFTP account + AutoSSL ────────────────
router.post('/', async (req, res) => {
  const { domain, docRoot, setupMailDns: wantsMailDns } = req.body;
  if (!domain) return res.json({ success: false, error: 'Domain name is required.' });

  try {
    // 1. Create Apache vhost (throws if already exists)
    apache.createVhost({ domain, docRoot });
    const root = docRoot || `/var/www/${domain}/public_html`;

    // 2. Create SFTP deploy account
    const username   = deriveUsername(domain);
    const password   = generatePassword(20);
    const adminEmail = getAdminEmail() || `admin@${domain}`;
    let accountError = null;
    try {
      createAccount({ domain, username, password, docRoot: root, allowShell: false });
    } catch (err) {
      accountError = err.message;
    }

    // 3. Auto-provision DNS (non-fatal)
    //    • Subdomain → A record injected into parent zone
    //    • Apex domain → full zone created
    const serverIp = getServerIp() || dns.SERVER_IP;
    const dnsResult = provisionDns(domain, serverIp);

    // 4. Optionally configure mail DNS + webmail vhost if user checked the box
    let mailDnsResult = null;
    if (wantsMailDns) {
      try {
        const applied = dns.setupMailDns(domain); // adds mail A, webmail A, MX, SPF, DMARC
        if (applied) {
          // Provision webmail.<domain> Apache vhost (proxy → DPanel)
          apache.createWebmailVhost(domain);
          // Best-effort SSL for webmail subdomain (may fail if DNS hasn't propagated yet)
          try { await ssl.autoSSL(`webmail.${domain}`, adminEmail); } catch (_) {}
          mailDnsResult = { applied: true, webmailUrl: `https://webmail.${domain}`, message: 'MX, SPF, DMARC, and webmail subdomain configured' };
        } else {
          mailDnsResult = { applied: false, message: 'No DNS zone found — configure manually once DNS propagates' };
        }
      } catch (err) {
        mailDnsResult = { applied: false, error: err.message };
      }
    }

    // 5. AutoSSL via certbot --apache (async — may take 15–30s)
    let sslStatus = 'pending';
    let sslError  = null;
    try {
      await ssl.autoSSL(domain, adminEmail);
      sslStatus = 'active';
    } catch (err) {
      sslStatus = 'failed';
      sslError  = err.message;
    }

    res.json({
      success: true,
      credentials: {
        domain,
        host:         serverIp,
        port:         22,
        docRoot:      root,
        username:     accountError ? null : username,
        password:     accountError ? null : password,
        accountError,
        sslStatus,
        sslError,
        dns:          dnsResult,
        mailDns:      mailDnsResult,
      }
    });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ── PUT /api/domains/:domain ──────────────────────────────────────────────────
router.put('/:domain', (req, res) => {
  try {
    apache.updateVhost(req.params.domain, req.body.content);
    res.json({ success: true });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// ── POST /api/domains/:domain/enable ─────────────────────────────────────────
router.post('/:domain/enable', (req, res) => {
  try { apache.enableVhost(req.params.domain); res.json({ success: true }); }
  catch (err) { res.json({ success: false, error: err.message }); }
});

// ── POST /api/domains/:domain/disable ────────────────────────────────────────
router.post('/:domain/disable', (req, res) => {
  try { apache.disableVhost(req.params.domain); res.json({ success: true }); }
  catch (err) { res.json({ success: false, error: err.message }); }
});

// ── DELETE /api/domains/:domain ───────────────────────────────────────────────
router.delete('/:domain', (req, res) => {
  try {
    const domain = req.params.domain;
    apache.deleteVhost(domain);
    // Remove the webmail proxy vhost if one was created for this domain
    apache.deleteWebmailVhost(domain);
    // Best-effort DNS cleanup — removes subdomain A records; apex zones preserved
    const dnsResult = deprovisionDns(domain);
    res.json({ success: true, dns: dnsResult });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// ── GET /api/domains/:domain/config ──────────────────────────────────────────
router.get('/:domain/config', (req, res) => {
  try { res.json({ success: true, data: apache.getVhostConfig(req.params.domain) }); }
  catch (err) { res.json({ success: false, error: err.message }); }
});

// ── Redirect helpers ──────────────────────────────────────────────────────────
const HTACCESS_START = '# BEGIN DPanel-Redirects';
const HTACCESS_END   = '# END DPanel-Redirects';

function getDocRoot(domain) {
  const { sanitizeDomain } = require('../lib/shell');
  sanitizeDomain(domain);
  const HIDDEN = ['-le-ssl', '000-default', 'default-ssl'];
  const vhosts = apache.listVhosts().filter(v => !HIDDEN.some(h => v.domain.endsWith(h)));
  const vhost  = vhosts.find(v => v.domain === domain);
  if (!vhost?.docRoot) throw new Error('Domain not found');
  return vhost.docRoot;
}

async function writeHtaccessBlock(domain, redirects) {
  const docRoot    = getDocRoot(domain);
  const htFile     = path.join(docRoot, '.htaccess');
  let existing     = '';
  if (fs.existsSync(htFile)) existing = fs.readFileSync(htFile, 'utf8');

  // Remove old DPanel block
  const startIdx = existing.indexOf(HTACCESS_START);
  const endIdx   = existing.indexOf(HTACCESS_END);
  if (startIdx !== -1 && endIdx !== -1) {
    existing = (existing.slice(0, startIdx) + existing.slice(endIdx + HTACCESS_END.length)).trim();
  }

  if (!redirects.length) {
    fs.writeFileSync(htFile, existing || '');
    return;
  }

  const lines = redirects.map(r => `Redirect ${r.type} ${r.from_path} ${r.to_url}`).join('\n');
  const block  = `\n${HTACCESS_START}\n${lines}\n${HTACCESS_END}\n`;
  fs.writeFileSync(htFile, (existing ? existing + '\n' : '') + block);
}

// ── GET /api/domains/:domain/redirects ────────────────────────────────────────
router.get('/:domain/redirects', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM dpanel_redirects WHERE domain = ? ORDER BY id',
      [req.params.domain]
    );
    res.json({ success: true, data: rows });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// ── POST /api/domains/:domain/redirects — add redirect ────────────────────────
router.post('/:domain/redirects', async (req, res) => {
  try {
    const domain    = req.params.domain;
    const { from_path, to_url, type = 301 } = req.body;
    if (!from_path || !to_url) return res.json({ success: false, error: 'from_path and to_url are required' });
    if (![301, 302].includes(Number(type))) return res.json({ success: false, error: 'type must be 301 or 302' });
    if (!from_path.startsWith('/')) return res.json({ success: false, error: 'from_path must start with /' });

    await pool.query(
      'INSERT INTO dpanel_redirects (domain, from_path, to_url, type) VALUES (?, ?, ?, ?)',
      [domain, from_path, to_url, type]
    );
    const [all] = await pool.query('SELECT * FROM dpanel_redirects WHERE domain = ? ORDER BY id', [domain]);
    await writeHtaccessBlock(domain, all);
    res.json({ success: true });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// ── DELETE /api/domains/:domain/redirects/:id ─────────────────────────────────
router.delete('/:domain/redirects/:id', async (req, res) => {
  try {
    const domain = req.params.domain;
    await pool.query('DELETE FROM dpanel_redirects WHERE id = ? AND domain = ?', [req.params.id, domain]);
    const [all] = await pool.query('SELECT * FROM dpanel_redirects WHERE domain = ? ORDER BY id', [domain]);
    await writeHtaccessBlock(domain, all);
    res.json({ success: true });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// ── GET /api/domains/:domain/diskusage ────────────────────────────────────────
router.get('/:domain/diskusage', (req, res) => {
  try {
    const { sanitizeDomain } = require('../lib/shell');
    sanitizeDomain(req.params.domain);
    const HIDDEN_SUFFIXES = ['-le-ssl', '000-default', 'default-ssl'];
    const vhosts = apache.listVhosts().filter(v =>
      !HIDDEN_SUFFIXES.some(h => v.domain.endsWith(h))
    );
    const vhost = vhosts.find(v => v.domain === req.params.domain);
    if (!vhost?.docRoot) return res.json({ success: false, error: 'Domain not found' });

    // du -sh on the docRoot; if it doesn't exist yet return 0
    const raw = execSync(
      `du -sb "${vhost.docRoot}" 2>/dev/null | cut -f1 || echo 0`,
      { encoding: 'utf8', timeout: 10000 }
    ).trim();
    const bytes = parseInt(raw, 10) || 0;

    // Human-readable
    function fmtBytes(b) {
      if (b < 1024) return b + ' B';
      if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
      if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
      return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB';
    }
    res.json({ success: true, data: { bytes, size: fmtBytes(bytes) } });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

module.exports = router;
