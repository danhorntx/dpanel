'use strict';
/**
 * routes/access.js — Domain-scoped access management for the SSH-first
 * Add Domain rewrite.
 *
 * All endpoints are nested under /api/domains/:domain/... but the route is
 * mounted separately so we can keep domains.js focused on vhost CRUD.
 *
 *   GET    /api/domains/:domain/access            — overview (account, keys, SSL state)
 *   POST   /api/domains/:domain/access/keys       — register a public key
 *   DELETE /api/domains/:domain/access/keys/:fp   — remove a public key (URL-encode fingerprint)
 *   POST   /api/domains/:domain/access/keys/generate — tmpfs keygen; returns private key ONCE
 *   POST   /api/domains/:domain/access/ftp/enable — enable FTP fallback (body: password)
 *   POST   /api/domains/:domain/access/ftp/reset  — reset FTP password
 *   POST   /api/domains/:domain/access/ftp/disable
 *   POST   /api/domains/:domain/access/shell      — toggle shell (body: allowShell)
 *   POST   /api/domains/:domain/access/ssl/retry  — manual retry for a single host (body: host)
 */

const express  = require('express');
const router   = express.Router({ mergeParams: true });
const ssh      = require('../lib/ssh');
const access   = require('../lib/access');
const sslretry = require('../lib/sslretry');
const { pool } = require('../lib/db');
const { sanitizeDomain } = require('../lib/shell');
const { requireDomainAccess } = require('../lib/auth');

// All routes here are domain-scoped — pull :domain, validate format, AND
// enforce per-user permission (admin or domain owner).
router.use('/:domain', (req, res, next) => {
  try {
    sanitizeDomain(req.params.domain);
    req.domain = req.params.domain;
    next();
  } catch (err) { res.status(400).json({ success: false, error: err.message }); }
});
router.use('/:domain', requireDomainAccess('domain'));

// ── GET /:domain/access ─────────────────────────────────────────────────────
// Returns: { account, keys, ssl, legacyAccounts, placeholder, vhost }
//
// account        — the key-managed deploy user (one per domain). null if not
//                  yet adopted. Adoption is initiated via POST /access/adopt.
// keys           — public keys attached to `account`
// ssl            — sslretry.statusFor() per-host attempt rollup
// legacyAccounts — additional rows in dpanel_sftp_accounts that aren't the
//                  primary (rare; for multi-account legacy domains)
// placeholder    — { enabled: bool } reflecting whether a Coming Soon
//                  index.html is currently in the docroot
// vhost          — { docRoot } so UI can render Connection without an extra call
router.get('/:domain/access', async (req, res) => {
  try {
    const [acctRows] = await pool.query(
      `SELECT username, doc_root, allow_shell, has_ssh_key, password_disabled, ftp_enabled, chroot_dir
       FROM dpanel_sftp_accounts WHERE domain = ? ORDER BY created_at ASC`,
      [req.domain]
    );
    const account        = acctRows[0] || null;
    const legacyAccounts = acctRows.slice(1).map(a => ({
      username:   a.username,
      docRoot:    a.doc_root,
      allowShell: !!a.allow_shell,
      hasSshKey:  !!a.has_ssh_key,
      ftpEnabled: !!a.ftp_enabled,
    }));
    const keys = account ? await access.listKeys(req.domain) : [];
    const ssl  = await sslretry.statusFor(req.domain);

    // Vhost + placeholder probe (best-effort — non-fatal on either failure).
    let vhost = null, placeholder = { enabled: false };
    try {
      const apache = require('../lib/apache');
      const v = apache.listVhosts().find(x => x.domain === req.domain);
      if (v) {
        vhost = { docRoot: v.docRoot };
        const fs   = require('fs');
        const path = require('path');
        const idx  = path.join(v.docRoot, 'index.html');
        if (fs.existsSync(idx)) {
          const head = fs.readFileSync(idx, 'utf8').slice(0, 200);
          placeholder.enabled = head.includes('DPanel-Placeholder');
        }
      }
    } catch (_) {}

    res.json({ success: true, data: { account, keys, ssl, legacyAccounts, placeholder, vhost } });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// ── POST /:domain/access/keys ───────────────────────────────────────────────
router.post('/:domain/access/keys', async (req, res) => {
  try {
    const { label, publicKey, source } = req.body;
    const result = await access.addKey(req.domain, {
      label,
      publicKey,
      source: source === 'generated' ? 'generated' : 'pasted',
      createdBy: req.session?.userId,
    });
    res.json({ success: true, data: result });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// ── DELETE /:domain/access/keys/:fingerprint ────────────────────────────────
router.delete('/:domain/access/keys/:fingerprint', async (req, res) => {
  try {
    const fp = decodeURIComponent(req.params.fingerprint);
    await access.removeKey(req.domain, fp, { actorId: req.session?.userId });
    res.json({ success: true });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// ── POST /:domain/access/keys/generate ──────────────────────────────────────
// Generates an ed25519 keypair in tmpfs, registers the public half, and
// returns the private key in the response body exactly once. The caller
// (UI) is responsible for offering it as a download and never re-fetching.
router.post('/:domain/access/keys/generate', async (req, res) => {
  try {
    const label  = (req.body?.label || `generated-${new Date().toISOString().slice(0,10)}`).slice(0, 128);
    const keypair = ssh.generateKeypair({ comment: `dpanel:${req.domain}` });
    await access.addKey(req.domain, {
      label,
      publicKey: keypair.publicKey,
      source:    'generated',
      createdBy: req.session?.userId,
    });
    res.json({
      success: true,
      data: {
        label,
        keyType:     keypair.keyType,
        fingerprint: keypair.fingerprint,
        publicKey:   keypair.publicKey,
        privateKey:  keypair.privateKey,  // shown ONCE — UI must not store
      },
    });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// ── POST /:domain/access/ftp/enable ─────────────────────────────────────────
router.post('/:domain/access/ftp/enable', async (req, res) => {
  try {
    const { password } = req.body || {};
    await access.enableFtp(req.domain, password, { actorId: req.session?.userId });
    res.json({ success: true });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// ── POST /:domain/access/ftp/disable ────────────────────────────────────────
router.post('/:domain/access/ftp/disable', async (req, res) => {
  try {
    await access.disableFtp(req.domain, { actorId: req.session?.userId });
    res.json({ success: true });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// ── POST /:domain/access/ftp/reset ──────────────────────────────────────────
router.post('/:domain/access/ftp/reset', async (req, res) => {
  try {
    const { password } = req.body || {};
    await access.resetFtpPassword(req.domain, password, { actorId: req.session?.userId });
    res.json({ success: true });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// ── POST /:domain/access/shell ──────────────────────────────────────────────
// Toggle shell access. Body: { allowShell: bool }. Reuses lib/access.js
// helpers — we look up the username, move groups, and set the login shell.
router.post('/:domain/access/shell', async (req, res) => {
  try {
    const { execSync } = require('child_process');
    const [rows] = await pool.query(
      'SELECT username FROM dpanel_sftp_accounts WHERE domain = ? LIMIT 1', [req.domain]
    );
    if (!rows.length) return res.json({ success: false, error: 'No deploy user for this domain.' });
    const username = rows[0].username;
    const allowShell = !!req.body?.allowShell;
    execSync(`usermod -s ${allowShell ? '/bin/bash' : '/usr/sbin/nologin'} ${username}`);
    if (allowShell) {
      try { execSync(`usermod -aG dpanel-shell ${username}`); } catch (_) {}
    } else {
      try { execSync(`gpasswd -d ${username} dpanel-shell`, { stdio: 'pipe' }); } catch (_) {}
    }
    await pool.query('UPDATE dpanel_sftp_accounts SET allow_shell = ? WHERE domain = ?',
                     [allowShell ? 1 : 0, req.domain]);
    res.json({ success: true });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// ── POST /:domain/access/adopt ──────────────────────────────────────────────
// Legacy-domain bridge: a domain that was provisioned BEFORE this rewrite has
// no row in dpanel_sftp_accounts and no key-managed deploy user. Calling this
// endpoint creates a deploy user for the existing Apache docroot WITHOUT
// changing the docroot location (kept at /var/www/<domain>/public_html) so
// existing files stay put.
//
// Body: { sshKeys: [{ label, publicKey }] }   - at least one key required
router.post('/:domain/access/adopt', async (req, res) => {
  try {
    const sshKeys = Array.isArray(req.body?.sshKeys) ? req.body.sshKeys : [];
    // Allow caller to override the auto-derived username when there's a
    // collision (e.g. somebody else's <short>_deploy already exists).
    const usernameOverride = (req.body?.username || '').toLowerCase().replace(/[^a-z0-9_-]/g, '');

    const [exists] = await pool.query(
      'SELECT username FROM dpanel_sftp_accounts WHERE domain = ? LIMIT 1', [req.domain]
    );
    if (exists.length) {
      return res.json({ success: false, error: `Domain already has a deploy user (${exists[0].username}).` });
    }
    // Look up the docroot from Apache.
    const apache = require('../lib/apache');
    const vhost  = apache.listVhosts().find(v => v.domain === req.domain);
    const docRoot = vhost?.docRoot;
    if (!docRoot) return res.json({ success: false, error: `No Apache vhost found for ${req.domain}.` });

    // Derive username (or use override). Reserved-username check + collision
    // detection prevent stepping on system users.
    let username = usernameOverride
      || ((req.domain.replace(/\.[^.]+$/,'').replace(/[^a-z0-9]/gi,'').toLowerCase().slice(0,24) || 'site') + '_deploy');
    if (ssh.isReservedUsername(username)) {
      return res.json({ success: false, error: `Username "${username}" is reserved. Pass a different one via body.username.` });
    }
    try {
      require('child_process').execSync(`id ${username}`, { stdio: 'pipe' });
      return res.json({ success: false, error: `System user "${username}" already exists. Pass a different one via body.username.`, code: 'username-taken' });
    } catch (_) { /* good — username is free */ }

    // Adoption: NOT chrooted (docroot stays at /var/www). User goes into
    // dpanel-ftp + www-data; password is locked unless FTP is enabled later.
    const { execSync } = require('child_process');
    access.ensureAccessConfig();
    execSync(`useradd -d ${docRoot} -s /usr/sbin/nologin -M -G www-data,dpanel-ftp ${username}`);
    try { execSync(`passwd -l ${username}`, { stdio: 'pipe' }); } catch (_) {}

    // Defensive chown of the docroot so the adopted user can read/write.
    try {
      const fs = require('fs');
      if (fs.existsSync(docRoot)) {
        execSync(`chown -R ${username}:www-data ${docRoot}`);
        execSync(`chmod -R 2775 ${docRoot}`);
      }
    } catch (_) { /* non-fatal — UI can offer a re-chown action */ }

    // Register in DB + JSON.
    await pool.query(
      `INSERT INTO dpanel_sftp_accounts (domain, username, doc_root, allow_shell, has_ssh_key, password_disabled, ftp_enabled, chroot_dir)
       VALUES (?, ?, ?, 0, ?, 1, 0, NULL)
       ON DUPLICATE KEY UPDATE doc_root=VALUES(doc_root)`,
      [req.domain, username, docRoot, sshKeys.length > 0 ? 1 : 0]
    );
    const accounts = access.readAccounts();
    if (!accounts.find(a => a.username === username)) {
      accounts.push({
        domain: req.domain, docRoot, username,
        allowShell: false, hasSshKey: sshKeys.length > 0,
        ftpEnabled: false, chroot: false,
        created: new Date().toISOString(),
      });
      access.writeAccounts(accounts);
    }

    // Register any keys the caller passed in (empty array is fine).
    for (const k of sshKeys) {
      try { await access.addKey(req.domain, { label: k.label, publicKey: k.publicKey, source: 'pasted', createdBy: req.session?.userId }); }
      catch (_) {}
    }

    res.json({ success: true, data: { username, docRoot, mode: 'adopted-legacy', keys: sshKeys.length } });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// ── DELETE /:domain/access/legacy/:username ─────────────────────────────────
// Remove a legacy (non-primary) account from a domain. The primary
// dpanel_sftp_accounts row (oldest by created_at) is protected — use
// Danger Zone delete for that.
router.delete('/:domain/access/legacy/:username', async (req, res) => {
  try {
    const username = req.params.username;
    const [rows] = await pool.query(
      'SELECT username FROM dpanel_sftp_accounts WHERE domain = ? ORDER BY created_at ASC',
      [req.domain]
    );
    if (rows.length && rows[0].username === username) {
      return res.json({ success: false, error: 'Cannot remove the primary deploy user via this endpoint. Use the danger zone delete.' });
    }
    if (!rows.find(r => r.username === username)) {
      return res.json({ success: false, error: 'Account not found for this domain.' });
    }
    access.deleteAccount(username);
    res.json({ success: true });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// ── POST /:domain/access/placeholder ────────────────────────────────────────
// Body: { enabled: bool }   true → write index.html, false → remove it
// The marker string DPanel-Placeholder lets us distinguish our placeholder
// from a user-written index.html (we never overwrite the latter).
router.post('/:domain/access/placeholder', async (req, res) => {
  try {
    const enabled = !!req.body?.enabled;
    const apache = require('../lib/apache');
    const v = apache.listVhosts().find(x => x.domain === req.domain);
    if (!v?.docRoot) return res.json({ success: false, error: 'No vhost for this domain.' });

    const fs   = require('fs');
    const path = require('path');
    const idx  = path.join(v.docRoot, 'index.html');

    if (enabled) {
      const html = `<!doctype html>
<!-- DPanel-Placeholder -->
<html lang="en"><head><meta charset="utf-8">
<title>${req.domain.replace(/[<>&]/g, '')} — Coming Soon</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  html,body{height:100%;margin:0;font-family:system-ui,sans-serif;background:#0f0f17;color:#e4e4e7}
  .wrap{min-height:100%;display:flex;align-items:center;justify-content:center;text-align:center;padding:2rem}
  h1{font-size:2rem;font-weight:600;margin:0 0 .5rem;letter-spacing:-.02em}
  p{margin:0;color:#a1a1aa}
</style></head>
<body><div class="wrap"><div>
  <h1>Coming soon</h1>
  <p>${req.domain.replace(/[<>&]/g, '')} is being prepared.</p>
</div></div></body></html>
`;
      // Safety: refuse to overwrite a user-written index.html. Only manage
      // files that already have our marker, or no file at all.
      if (fs.existsSync(idx)) {
        const cur = fs.readFileSync(idx, 'utf8').slice(0, 200);
        if (!cur.includes('DPanel-Placeholder')) {
          return res.json({ success: false, error: 'A non-placeholder index.html exists. Move it aside before enabling.' });
        }
      }
      fs.writeFileSync(idx, html);
    } else {
      if (fs.existsSync(idx)) {
        const cur = fs.readFileSync(idx, 'utf8').slice(0, 200);
        if (cur.includes('DPanel-Placeholder')) fs.unlinkSync(idx);
      }
    }
    res.json({ success: true });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// ── POST /:domain/access/ssl/retry ──────────────────────────────────────────
// Body: { host: 'webmail.example.com' }  (defaults to the apex domain)
router.post('/:domain/access/ssl/retry', async (req, res) => {
  try {
    const host = (req.body?.host || req.domain).toString();
    await sslretry.retryNow(req.domain, host, { actorId: req.session?.userId });
    res.json({ success: true });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

module.exports = router;
