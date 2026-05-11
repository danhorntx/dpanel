'use strict';
const express  = require('express');
const fs       = require('fs');
const { execSync } = require('child_process');
const {
  readAccounts, writeAccounts,
  sanitizeUsername, setPassword, userExists,
  createAccount, deleteAccount
} = require('../lib/access');
const { logAction } = require('../lib/shell');
const router   = express.Router();

const HOME_BASE = '/home';

// ── GET /api/ftp?domain=x ─────────────────────────────────────────────────────
router.get('/', (req, res) => {
  let accounts = readAccounts();
  if (req.query.domain) accounts = accounts.filter(a => a.domain === req.query.domain);
  res.json({ success: true, data: accounts });
});

// ── POST /api/ftp — create account ────────────────────────────────────────────
router.post('/', (req, res) => {
  const { domain, docRoot, password, allowShell, sshKey } = req.body;
  let { username } = req.body;

  if (!domain || !username || !password)
    return res.json({ success: false, error: 'Domain, username, and password are required.' });

  const clean = sanitizeUsername(username);
  if (clean !== username.toLowerCase().replace(/[^a-z0-9_-]/g, ''))
    return res.json({ success: false, error: 'Username may only contain lowercase letters, numbers, hyphens and underscores.' });
  if (password.length < 8)
    return res.json({ success: false, error: 'Password must be at least 8 characters.' });

  try {
    createAccount({ domain, username: clean, password, docRoot, allowShell, sshKey });
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ── DELETE /api/ftp/:username ─────────────────────────────────────────────────
router.delete('/:username', (req, res) => {
  try {
    deleteAccount(req.params.username);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ── PUT /api/ftp/:username/password ──────────────────────────────────────────
router.put('/:username/password', (req, res) => {
  const username = sanitizeUsername(req.params.username);
  const { password } = req.body;
  if (!password || password.length < 8)
    return res.json({ success: false, error: 'Password must be at least 8 characters.' });
  try {
    setPassword(username, password);
    logAction('access:password', username, 'ok');
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ── PUT /api/ftp/:username/sshkey ─────────────────────────────────────────────
router.put('/:username/sshkey', (req, res) => {
  const username = sanitizeUsername(req.params.username);
  const { sshKey } = req.body;
  try {
    const sshDir = `${HOME_BASE}/${username}/.ssh`;
    if (sshKey && sshKey.trim()) {
      fs.mkdirSync(sshDir, { recursive: true });
      fs.writeFileSync(`${sshDir}/authorized_keys`, sshKey.trim() + '\n', { mode: 0o600 });
      execSync(`chmod 700 ${sshDir}`);
      execSync(`chown -R ${username}:${username} ${sshDir}`);
    } else {
      if (fs.existsSync(`${sshDir}/authorized_keys`)) fs.unlinkSync(`${sshDir}/authorized_keys`);
    }
    const accounts = readAccounts();
    const acc = accounts.find(a => a.username === username);
    if (acc) { acc.hasSshKey = !!(sshKey && sshKey.trim()); writeAccounts(accounts); }
    logAction('access:sshkey', username, sshKey ? 'set' : 'removed');
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ── PUT /api/ftp/:username/shell ──────────────────────────────────────────────
// Toggle shell access on an existing account.
// Body: { allowShell: true|false }
router.put('/:username/shell', (req, res) => {
  const username = sanitizeUsername(req.params.username);
  const allowShell = !!req.body.allowShell;
  if (!userExists(username))
    return res.json({ success: false, error: `User "${username}" not found.` });
  try {
    const shell = allowShell ? '/bin/bash' : '/usr/sbin/nologin';
    execSync(`usermod -s ${shell} ${username}`);

    // Sync group membership: shell users must NOT be in dpanel-sftp (which ForceCommands to sftp)
    if (allowShell) {
      try { execSync(`gpasswd -d ${username} dpanel-sftp 2>/dev/null`); } catch (_) {}
    } else {
      try { execSync(`usermod -aG dpanel-sftp ${username}`); } catch (_) {}
    }

    // Persist to access-accounts.json
    const accounts = readAccounts();
    const acc = accounts.find(a => a.username === username);
    if (acc) { acc.allowShell = allowShell; writeAccounts(accounts); }

    logAction('access:shell', username, allowShell ? 'enabled' : 'disabled');
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ── POST /api/ftp/generate-keypair ────────────────────────────────────────────
router.post('/generate-keypair', (req, res) => {
  const tmpKey = `/tmp/dpanel_keygen_${Date.now()}`;
  try {
    execSync(`ssh-keygen -t ed25519 -f ${tmpKey} -N "" -C "dpanel-generated" -q`);
    const privateKey = fs.readFileSync(tmpKey, 'utf8');
    const publicKey  = fs.readFileSync(`${tmpKey}.pub`, 'utf8').trim();
    fs.unlinkSync(tmpKey);
    fs.unlinkSync(`${tmpKey}.pub`);
    res.json({ success: true, privateKey, publicKey });
  } catch (err) {
    try { fs.unlinkSync(tmpKey); } catch (_) {}
    try { fs.unlinkSync(`${tmpKey}.pub`); } catch (_) {}
    res.json({ success: false, error: err.message });
  }
});

module.exports = router;
