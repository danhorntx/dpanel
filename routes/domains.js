'use strict';
const express    = require('express');
const crypto     = require('crypto');
const { execSync } = require('child_process');
const fs         = require('fs');
const path       = require('path');
const apache     = require('../lib/apache');
const { createAccount } = require('../lib/access');
const ssl        = require('../lib/ssl');
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

// ── GET /api/domains ──────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  try {
    const HIDDEN = ['-le-ssl', '000-default', 'default-ssl'];
    const vhosts = apache.listVhosts().filter(v => !HIDDEN.some(h => v.domain.endsWith(h)));
    res.json({ success: true, data: vhosts });
  }
  catch (err) { res.json({ success: false, error: err.message }); }
});

// ── POST /api/domains — create vhost + SFTP account + AutoSSL ────────────────
router.post('/', async (req, res) => {
  const { domain, docRoot } = req.body;
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

    // 3. AutoSSL via certbot --apache (async — may take 15–30s)
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
        host:         getServerIp(),
        port:         22,
        docRoot:      root,
        username:     accountError ? null : username,
        password:     accountError ? null : password,
        accountError,
        sslStatus,
        sslError
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
  try { apache.deleteVhost(req.params.domain); res.json({ success: true }); }
  catch (err) { res.json({ success: false, error: err.message }); }
});

// ── GET /api/domains/:domain/config ──────────────────────────────────────────
router.get('/:domain/config', (req, res) => {
  try { res.json({ success: true, data: apache.getVhostConfig(req.params.domain) }); }
  catch (err) { res.json({ success: false, error: err.message }); }
});

module.exports = router;
