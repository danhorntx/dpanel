'use strict';
const fs   = require('fs');
const path = require('path');
const { spawnSync, execSync } = require('child_process');
const { sanitizePath, logAction } = require('./shell');

const ACCOUNTS_FILE = path.join(__dirname, '..', 'access-accounts.json');
const KEYS_DIR      = '/etc/dpanel-keys';

// ── Persistence ───────────────────────────────────────────────────────────────
function readAccounts() {
  if (!fs.existsSync(ACCOUNTS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8')); } catch (_) { return []; }
}
function writeAccounts(a) {
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(a, null, 2));
  execSync(`chmod 600 ${ACCOUNTS_FILE}`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function sanitizeUsername(u) {
  return (u || '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
}
function setPassword(username, password) {
  const r = spawnSync('chpasswd', [], { input: `${username}:${password}`, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr || 'chpasswd failed');
}
function userExists(username) {
  try { execSync(`id ${username}`, { stdio: 'pipe' }); return true; } catch (_) { return false; }
}
function ensureSftpGroup() {
  try { execSync('getent group dpanel-sftp', { stdio: 'pipe' }); }
  catch (_) { execSync('groupadd dpanel-sftp'); }
}
function ensureSshdConfig() {
  const confPath = '/etc/ssh/sshd_config.d/dpanel-sftp.conf';
  const conf = `# Managed by DPanel — do not edit manually
AuthorizedKeysFile .ssh/authorized_keys /etc/dpanel-keys/%u/authorized_keys

Match Group dpanel-sftp
    ForceCommand internal-sftp
    PasswordAuthentication yes
    AllowTcpForwarding no
    X11Forwarding no
`;
  const current = fs.existsSync(confPath) ? fs.readFileSync(confPath, 'utf8') : '';
  if (!current.includes('Match Group dpanel-sftp')) {
    fs.writeFileSync(confPath, conf);
    try { execSync('systemctl reload ssh || systemctl reload sshd'); } catch (_) {}
  }
}

// ── createAccount ─────────────────────────────────────────────────────────────
function createAccount({ domain, username, password, docRoot, allowShell = false, sshKey = '' }) {
  username = sanitizeUsername(username);
  if (!domain || !username || !password) throw new Error('Domain, username, and password are required.');
  if (password.length < 8) throw new Error('Password must be at least 8 characters.');

  const accounts = readAccounts();
  if (accounts.find(a => a.username === username))
    throw new Error(`Username "${username}" is already taken.`);
  if (userExists(username))
    throw new Error(`System user "${username}" already exists.`);

  const home  = docRoot || `/var/www/${domain}/public_html`;
  const shell = allowShell ? '/bin/bash' : '/usr/sbin/nologin';

  ensureSftpGroup();
  const groups = allowShell ? 'www-data' : 'www-data,dpanel-sftp';
  execSync(`useradd -d ${sanitizePath(home)} -s ${shell} -M -G ${groups} ${username}`);
  setPassword(username, password);

  if (sshKey && sshKey.trim()) {
    const keyDir = `${KEYS_DIR}/${username}`;
    fs.mkdirSync(keyDir, { recursive: true });
    fs.writeFileSync(`${keyDir}/authorized_keys`, sshKey.trim() + '\n', { mode: 0o600 });
    execSync(`chown -R root:${username} ${keyDir}`);
    execSync(`chmod 750 ${keyDir}`);
  }

  if (fs.existsSync(home)) {
    execSync(`chown -R ${username}:www-data ${sanitizePath(home)}`);
    execSync(`chmod -R 2775 ${sanitizePath(home)}`);
  }

  ensureSshdConfig();

  const record = {
    domain,
    docRoot: home,
    username,
    allowShell: !!allowShell,
    hasSshKey:  !!(sshKey && sshKey.trim()),
    created:    new Date().toISOString()
  };
  accounts.push(record);
  writeAccounts(accounts);
  logAction('access:create', `${username}@${domain}`, 'ok');
  return record;
}

// ── deleteAccount ─────────────────────────────────────────────────────────────
function deleteAccount(username) {
  username = sanitizeUsername(username);
  if (userExists(username)) execSync(`userdel ${username}`);
  const keyDir = `${KEYS_DIR}/${username}`;
  if (fs.existsSync(keyDir)) fs.rmSync(keyDir, { recursive: true, force: true });
  const accounts = readAccounts().filter(a => a.username !== username);
  writeAccounts(accounts);
  logAction('access:delete', username, 'ok');
}

module.exports = {
  readAccounts, writeAccounts,
  sanitizeUsername, setPassword, userExists,
  ensureSftpGroup, ensureSshdConfig,
  createAccount, deleteAccount
};
