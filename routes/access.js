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
router.get('/:domain/access', async (req, res) => {
  try {
    const [acctRows] = await pool.query(
      `SELECT username, doc_root, allow_shell, has_ssh_key, password_disabled, ftp_enabled, chroot_dir
       FROM dpanel_sftp_accounts WHERE domain = ? LIMIT 1`,
      [req.domain]
    );
    const account = acctRows[0] || null;
    const keys    = await access.listKeys(req.domain);
    const ssl     = await sslretry.statusFor(req.domain);
    res.json({ success: true, data: { account, keys, ssl } });
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
    const { sshKeys } = req.body || {};
    if (!Array.isArray(sshKeys) || sshKeys.length === 0) {
      return res.json({ success: false, error: 'At least one SSH key is required to adopt a legacy domain.' });
    }
    const [exists] = await pool.query(
      'SELECT username FROM dpanel_sftp_accounts WHERE domain = ? LIMIT 1', [req.domain]
    );
    if (exists.length) {
      return res.json({ success: false, error: `Domain already has a deploy user (${exists[0].username}).` });
    }
    // Look up the docroot from Apache so we can chown it correctly.
    const apache = require('../lib/apache');
    const vhost  = apache.listVhosts().find(v => v.domain === req.domain);
    const docRoot = vhost?.docRoot;
    if (!docRoot) return res.json({ success: false, error: `No Apache vhost found for ${req.domain}.` });

    // Use the legacy createAccount path: NOT chrooted, docroot stays where it
    // was, user goes into dpanel-ftp (password locked) + we paste their key.
    const crypto = require('crypto');
    const tempPassword = crypto.randomBytes(24).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 20);
    const username = (req.domain.replace(/\.[^.]+$/,'').replace(/[^a-z0-9]/gi,'').toLowerCase().slice(0,24) || 'site') + '_deploy';

    access.createAccount({
      domain:     req.domain,
      username,
      password:   tempPassword,
      docRoot,
      allowShell: false,
      sshKey:     sshKeys[0].publicKey,
    });
    // Lock the password (key-only) and register the rest of the keys.
    try { require('child_process').execSync(`passwd -l ${username}`, { stdio: 'pipe' }); } catch (_) {}
    for (let i = 1; i < sshKeys.length; i++) {
      try { await access.addKey(req.domain, { label: sshKeys[i].label, publicKey: sshKeys[i].publicKey, createdBy: req.session?.userId }); } catch (_) {}
    }
    // Mirror the first key into dpanel_domain_keys (createAccount only writes JSON).
    try {
      const parsed = ssh.parsePublicKey(sshKeys[0].publicKey);
      await pool.query(
        `INSERT IGNORE INTO dpanel_domain_keys (domain, username, label, key_type, fingerprint, public_key, source, created_by)
         VALUES (?, ?, ?, ?, ?, ?, 'pasted', ?)`,
        [req.domain, username, (sshKeys[0].label || 'primary').slice(0,128), parsed.keyType, parsed.fingerprint, parsed.normalized, req.session?.userId || null]
      );
      await pool.query(
        `INSERT INTO dpanel_sftp_accounts (domain, username, doc_root, allow_shell, has_ssh_key, password_disabled, ftp_enabled, chroot_dir)
         VALUES (?, ?, ?, 0, 1, 1, 0, NULL)
         ON DUPLICATE KEY UPDATE doc_root=VALUES(doc_root), has_ssh_key=1, password_disabled=1`,
        [req.domain, username, docRoot]
      );
    } catch (_) {}
    res.json({ success: true, data: { username, docRoot, mode: 'adopted-legacy' } });
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
