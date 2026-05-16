'use strict';
/**
 * lib/access.js — Domain user lifecycle (SSH-first, with backward-compat).
 *
 * Two account flavours coexist:
 *
 *   Legacy (pre-rewrite):
 *     createAccount({ domain, username, password, docRoot, allowShell, sshKey })
 *     - Used by routes/ftp.js manual account creation and any older callers.
 *     - Home = docRoot (typically /var/www/<domain>/public_html).
 *     - Joined to dpanel-ftp group → password auth allowed, no chroot.
 *
 *   SSH-first:
 *     provisionDomainUser({ domain, sshKeys, allowShell, label })
 *     - Used by the new POST /api/domains flow.
 *     - Home = /home/<derived_username>   (root-owned chroot jail)
 *     - Docroot = /home/<user>/public_html  (<user>:www-data writable)
 *     - Joined to dpanel-sftp group (key-only, chrooted) by default.
 *     - allowShell=true → dpanel-shell group, not chrooted.
 *
 * Key management (new):
 *     addKey / removeKey / listKeys / rewriteAuthorizedKeysFor(domain)
 *
 * FTP toggle (new):
 *     enableFtp(username, password)   — adds to dpanel-ftp, sets password
 *     disableFtp(username)            — removes from dpanel-ftp, locks password
 *
 * One-time migration:
 *     ensureAccessConfig() runs lazily — first call moves any legacy
 *     password-only account from dpanel-sftp into dpanel-ftp (so password
 *     auth keeps working under the new sshd_config drop-in which has
 *     PasswordAuthentication=no inside Match Group dpanel-sftp).
 */

const fs   = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');
const ssh  = require('./ssh');
const { pool, audit } = require('./db');
const { sanitizePath, logAction } = require('./shell');

const ACCOUNTS_FILE      = path.join(__dirname, '..', 'access-accounts.json');
const HOME_BASE          = '/home';
const MIGRATION_FLAG     = '/var/lib/dpanel/.access-migrated-v2';
const LEGACY_SSHD_DROPIN = '/etc/ssh/sshd_config.d/dpanel-sftp.conf';

// ── Persistence (JSON fallback — DB is authoritative once migrated) ──────────
function readAccounts() {
  if (!fs.existsSync(ACCOUNTS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8')); } catch (_) { return []; }
}
function writeAccounts(a) {
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(a, null, 2));
  try { execSync(`chmod 600 ${ACCOUNTS_FILE}`); } catch (_) {}
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function sanitizeUsername(u) {
  return (u || '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
}
function setPassword(username, password) {
  const r = spawnSync('chpasswd', [], { input: `${username}:${password}`, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr || 'chpasswd failed');
}
function lockPassword(username) {
  try { execSync(`passwd -l ${username}`, { stdio: 'pipe' }); } catch (_) {}
}
function userExists(username) {
  try { execSync(`id ${username}`, { stdio: 'pipe' }); return true; } catch (_) { return false; }
}
function userInGroup(username, group) {
  try {
    const out = execSync(`id -nG ${username}`, { encoding: 'utf8' });
    return out.split(/\s+/).includes(group);
  } catch (_) { return false; }
}
function deriveUsername(domain) {
  const base = domain
    .replace(/\.[^.]+$/, '')
    .replace(/\./g, '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase()
    .slice(0, 24);
  return (base || 'site') + '_deploy';
}

// ── One-time migration + sshd_config drop-in ─────────────────────────────────
/**
 * Ensure groups exist, migrate legacy accounts (password-only users that
 * lived in dpanel-sftp under the OLD drop-in get moved to dpanel-ftp so
 * their passwords keep working under the NEW drop-in), then install the
 * new sshd_config drop-in.
 *
 * Safe to call on every account operation — the migration flag file
 * short-circuits after the first successful run.
 */
function ensureAccessConfig() {
  ssh.ensureGroups();

  if (!fs.existsSync(MIGRATION_FLAG)) {
    try {
      const accounts = readAccounts();
      for (const a of accounts) {
        if (!userExists(a.username)) continue;
        // Anyone without a key needs password auth → put them in dpanel-ftp.
        // Anyone with a key is fine in dpanel-sftp (which is now key-only).
        if (!a.hasSshKey) {
          try { execSync(`usermod -aG dpanel-ftp ${a.username}`, { stdio: 'pipe' }); } catch (_) {}
        }
      }
      // Retire the legacy drop-in (its Match block conflicts with ours).
      if (fs.existsSync(LEGACY_SSHD_DROPIN)) {
        try { fs.unlinkSync(LEGACY_SSHD_DROPIN); } catch (_) {}
      }
      fs.mkdirSync(path.dirname(MIGRATION_FLAG), { recursive: true });
      fs.writeFileSync(MIGRATION_FLAG, new Date().toISOString() + '\n');
      logAction('access:migrate', 'all', 'ok');
    } catch (err) {
      // Don't block account ops if migration trips; log and continue.
      logAction('access:migrate', 'all', `error: ${err.message}`);
    }
  }

  ssh.ensureSshdDropin();
}

// ── Legacy createAccount — FTP-style, kept for routes/ftp.js compat ─────────
/**
 * Create an FTP-style account. NEW domains should use provisionDomainUser()
 * instead — this entry point is here for routes/ftp.js (manual create) and
 * any tooling that hasn't migrated yet.
 *
 * The account goes into dpanel-ftp (password allowed, chrooted SFTP) plus
 * dpanel-shell if allowShell.
 */
function createAccount({ domain, username, password, docRoot, allowShell = false, sshKey = '' }) {
  username = sanitizeUsername(username);
  if (!domain || !username || !password) throw new Error('Domain, username, and password are required.');
  if (password.length < 8)        throw new Error('Password must be at least 8 characters.');
  if (ssh.isReservedUsername(username)) throw new Error(`Username "${username}" is reserved.`);

  const accounts = readAccounts();
  if (accounts.find(a => a.username === username))
    throw new Error(`Username "${username}" is already taken.`);
  if (userExists(username))
    throw new Error(`System user "${username}" already exists.`);

  ensureAccessConfig();

  const home  = docRoot || `/var/www/${domain}/public_html`;
  const shell = allowShell ? '/bin/bash' : '/usr/sbin/nologin';
  // Legacy mode: NOT chrooted (home != /home/<user>). Put in dpanel-ftp so
  // password auth still works. Shell users get dpanel-shell membership too.
  const groups = ['www-data', 'dpanel-ftp'];
  if (allowShell) groups.push('dpanel-shell');

  execSync(`useradd -d ${sanitizePath(home)} -s ${shell} -M -G ${groups.join(',')} ${username}`);
  setPassword(username, password);

  if (sshKey && sshKey.trim()) {
    const parsed = ssh.parsePublicKey(sshKey);
    ssh.writeAuthorizedKeys(username, [parsed.normalized]);
  }
  if (fs.existsSync(home)) {
    execSync(`chown -R ${username}:www-data ${sanitizePath(home)}`);
    execSync(`chmod -R 2775 ${sanitizePath(home)}`);
  }

  const record = {
    domain,
    docRoot: home,
    username,
    allowShell: !!allowShell,
    hasSshKey:  !!(sshKey && sshKey.trim()),
    ftpEnabled: true,
    chroot:     false,
    created:    new Date().toISOString(),
  };
  accounts.push(record);
  writeAccounts(accounts);
  logAction('access:create-legacy', `${username}@${domain}`, 'ok');
  audit(null, null, 'access:create', domain, `username=${username} mode=legacy`);
  return record;
}

// ── New SSH-first provisioner ────────────────────────────────────────────────
/**
 * Provision a domain user under the SSH-first model.
 *
 * @param {object} spec
 * @param {string}   spec.domain
 * @param {Array<{ label:string, publicKey:string, source?:'pasted'|'generated' }>} [spec.sshKeys]
 *        At least one key is required UNLESS allowFtp is true (which still
 *        forces a password). Generated-keypair callers should pass the public
 *        half here with source:'generated' so we can label it in the UI.
 * @param {boolean}  [spec.allowShell=false]
 * @param {boolean}  [spec.allowFtp=false]     - enable password-auth FTP fallback
 * @param {string}   [spec.password]           - required if allowFtp; ignored otherwise
 * @param {number}   [spec.createdBy]          - dpanel_users.id of the actor
 *
 * @returns {{ username:string, docRoot:string, chrootDir:string, keys:object[] }}
 */
function provisionDomainUser(spec) {
  if (!spec || !spec.domain) throw new Error('domain is required');
  const domain     = spec.domain;
  const allowShell = !!spec.allowShell;
  const allowFtp   = !!spec.allowFtp;
  const sshKeys    = Array.isArray(spec.sshKeys) ? spec.sshKeys : [];
  const password   = spec.password || '';

  if (!allowFtp && sshKeys.length === 0)
    throw new Error('At least one SSH public key is required (or enable FTP fallback).');
  if (allowFtp && (!password || password.length < 8))
    throw new Error('FTP fallback requires a password of 8+ characters.');

  // Pre-parse keys so any malformed input fails before we touch the system.
  const parsedKeys = sshKeys.map(k => {
    const p = ssh.parsePublicKey(k.publicKey);
    return { ...p, label: (k.label || '').slice(0, 128) || 'primary', source: k.source || 'pasted' };
  });

  let username = deriveUsername(domain);
  // Collision avoidance: append _2, _3 if the derived username is taken.
  if (userExists(username) || ssh.isReservedUsername(username)) {
    for (let i = 2; i < 100; i++) {
      const candidate = `${username}_${i}`;
      if (!userExists(candidate) && !ssh.isReservedUsername(candidate)) { username = candidate; break; }
    }
  }
  if (userExists(username) || ssh.isReservedUsername(username))
    throw new Error('Could not derive a free username for this domain.');

  ensureAccessConfig();

  const home    = `${HOME_BASE}/${username}`;
  const docRoot = `${home}/public_html`;
  const shell   = allowShell ? '/bin/bash' : '/usr/sbin/nologin';

  // Group membership:
  //   - dpanel-sftp default (chrooted, key-only)
  //   - dpanel-shell if shell enabled (no chroot, key-only)
  //   - dpanel-ftp if FTP fallback enabled (chrooted, password allowed)
  //   - always www-data so Apache can read the docroot
  const groups = ['www-data'];
  if (allowShell) groups.push('dpanel-shell');
  else            groups.push('dpanel-sftp');
  if (allowFtp)   groups.push('dpanel-ftp');

  // useradd. -m creates /home/<user>; we then chown root:root + chmod 755
  // to satisfy the chroot requirement. The user owns public_html/ inside.
  execSync(`useradd -m -d ${home} -s ${shell} -G ${groups.join(',')} ${username}`);

  // Chroot jail invariant: /home/<user> must be root-owned 755 for ChrootDirectory.
  try {
    execSync(`chown root:root ${home}`);
    execSync(`chmod 755 ${home}`);
  } catch (_) { /* still functional for shell users (not chrooted) */ }

  // User-writable docroot inside the jail.
  fs.mkdirSync(docRoot, { recursive: true });
  execSync(`chown -R ${username}:www-data ${docRoot}`);
  execSync(`chmod 2775 ${docRoot}`);

  // SSH keys
  if (parsedKeys.length) {
    ssh.writeAuthorizedKeys(username, parsedKeys.map(p => p.normalized));
  }

  // Password handling
  if (allowFtp) {
    setPassword(username, password);
  } else {
    lockPassword(username);
  }

  // Persist keys + account row(s). Best-effort DB writes — the JSON file
  // remains the legacy source of truth for routes/ftp.js consumers.
  const accounts = readAccounts();
  accounts.push({
    domain,
    docRoot,
    username,
    allowShell,
    hasSshKey:  parsedKeys.length > 0,
    ftpEnabled: allowFtp,
    chroot:     !allowShell,
    created:    new Date().toISOString(),
  });
  writeAccounts(accounts);

  // Mirror into DB so the new Access tab can list keys.
  (async () => {
    try {
      await pool.query(
        `INSERT INTO dpanel_sftp_accounts (domain, username, doc_root, allow_shell, has_ssh_key, password_disabled, ftp_enabled, chroot_dir)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           domain=VALUES(domain), doc_root=VALUES(doc_root),
           allow_shell=VALUES(allow_shell), has_ssh_key=VALUES(has_ssh_key),
           password_disabled=VALUES(password_disabled), ftp_enabled=VALUES(ftp_enabled),
           chroot_dir=VALUES(chroot_dir)`,
        [domain, username, docRoot, allowShell ? 1 : 0, parsedKeys.length ? 1 : 0,
         allowFtp ? 0 : 1, allowFtp ? 1 : 0, allowShell ? null : home]
      );
      for (const k of parsedKeys) {
        await pool.query(
          `INSERT IGNORE INTO dpanel_domain_keys (domain, username, label, key_type, fingerprint, public_key, source, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [domain, username, k.label, k.keyType, k.fingerprint, k.normalized, k.source, spec.createdBy || null]
        );
      }
    } catch (_) { /* non-fatal — JSON file still has the account */ }
  })();

  logAction('access:provision', `${username}@${domain}`, 'ok');
  audit(spec.createdBy || null, null, 'access:provision', domain,
        `username=${username} keys=${parsedKeys.length} ftp=${allowFtp} shell=${allowShell}`);

  return {
    username,
    docRoot,
    chrootDir: allowShell ? null : home,
    keys: parsedKeys.map(p => ({ label: p.label, fingerprint: p.fingerprint, keyType: p.keyType })),
  };
}

// ── Key CRUD (DB-backed) ─────────────────────────────────────────────────────
async function listKeys(domain) {
  const [rows] = await pool.query(
    `SELECT id, domain, username, label, key_type, fingerprint, source, created_at, last_used_at
     FROM dpanel_domain_keys WHERE domain = ? ORDER BY created_at`,
    [domain]
  );
  return rows;
}

async function addKey(domain, { label, publicKey, source = 'pasted', createdBy }) {
  const [acct] = await pool.query(
    'SELECT username FROM dpanel_sftp_accounts WHERE domain = ? LIMIT 1',
    [domain]
  );
  if (!acct.length) throw new Error(`No deploy user exists for ${domain}.`);
  const username = acct[0].username;

  const parsed = ssh.parsePublicKey(publicKey);
  const cleanLabel = (label || '').slice(0, 128) || 'key';

  try {
    await pool.query(
      `INSERT INTO dpanel_domain_keys (domain, username, label, key_type, fingerprint, public_key, source, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [domain, username, cleanLabel, parsed.keyType, parsed.fingerprint, parsed.normalized, source, createdBy || null]
    );
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw new Error('This key is already registered for this domain.');
    throw err;
  }

  await rewriteAuthorizedKeysFor(domain);
  // has_ssh_key flag on parent account
  await pool.query('UPDATE dpanel_sftp_accounts SET has_ssh_key = 1 WHERE domain = ?', [domain]);

  audit(createdBy || null, null, 'access:key-add', domain, `${parsed.keyType} ${parsed.fingerprint}`);
  return { label: cleanLabel, fingerprint: parsed.fingerprint, keyType: parsed.keyType };
}

async function removeKey(domain, fingerprint, opts = {}) {
  const [rows] = await pool.query(
    'SELECT id, key_type, fingerprint FROM dpanel_domain_keys WHERE domain = ? AND fingerprint = ?',
    [domain, fingerprint]
  );
  if (!rows.length) throw new Error('Key not found.');

  await pool.query('DELETE FROM dpanel_domain_keys WHERE id = ?', [rows[0].id]);
  await rewriteAuthorizedKeysFor(domain);

  // If no keys remain, clear the has_ssh_key flag.
  const [[count]] = await pool.query(
    'SELECT COUNT(*) AS n FROM dpanel_domain_keys WHERE domain = ?', [domain]
  );
  await pool.query(
    'UPDATE dpanel_sftp_accounts SET has_ssh_key = ? WHERE domain = ?',
    [count.n > 0 ? 1 : 0, domain]
  );

  audit(opts.actorId || null, null, 'access:key-remove', domain, fingerprint);
}

/**
 * Rewrite the authorized_keys file for a domain from the keys recorded in DB.
 * Idempotent. Called after every add/remove.
 */
async function rewriteAuthorizedKeysFor(domain) {
  const [acct] = await pool.query(
    'SELECT username FROM dpanel_sftp_accounts WHERE domain = ? LIMIT 1', [domain]
  );
  if (!acct.length) return;
  const username = acct[0].username;
  const [keys] = await pool.query(
    'SELECT public_key FROM dpanel_domain_keys WHERE domain = ? ORDER BY created_at', [domain]
  );
  ssh.writeAuthorizedKeys(username, keys.map(k => k.public_key));
}

// ── FTP toggle ──────────────────────────────────────────────────────────────
async function enableFtp(domain, password, opts = {}) {
  if (!password || password.length < 8) throw new Error('Password must be at least 8 characters.');
  const [acct] = await pool.query(
    'SELECT username FROM dpanel_sftp_accounts WHERE domain = ? LIMIT 1', [domain]
  );
  if (!acct.length) throw new Error(`No deploy user exists for ${domain}.`);
  const username = acct[0].username;

  try { execSync(`usermod -aG dpanel-ftp ${username}`); } catch (_) {}
  setPassword(username, password);
  await pool.query('UPDATE dpanel_sftp_accounts SET ftp_enabled = 1 WHERE domain = ?', [domain]);
  audit(opts.actorId || null, null, 'access:ftp-enable', domain, username);
}

async function disableFtp(domain, opts = {}) {
  const [acct] = await pool.query(
    'SELECT username FROM dpanel_sftp_accounts WHERE domain = ? LIMIT 1', [domain]
  );
  if (!acct.length) return;
  const username = acct[0].username;
  try { execSync(`gpasswd -d ${username} dpanel-ftp`, { stdio: 'pipe' }); } catch (_) {}
  lockPassword(username);
  await pool.query('UPDATE dpanel_sftp_accounts SET ftp_enabled = 0 WHERE domain = ?', [domain]);
  audit(opts.actorId || null, null, 'access:ftp-disable', domain, username);
}

async function resetFtpPassword(domain, password, opts = {}) {
  if (!password || password.length < 8) throw new Error('Password must be at least 8 characters.');
  const [acct] = await pool.query(
    'SELECT username, ftp_enabled FROM dpanel_sftp_accounts WHERE domain = ? LIMIT 1', [domain]
  );
  if (!acct.length) throw new Error(`No deploy user exists for ${domain}.`);
  if (!acct[0].ftp_enabled) throw new Error('FTP is not enabled for this domain.');
  setPassword(acct[0].username, password);
  audit(opts.actorId || null, null, 'access:ftp-reset', domain, acct[0].username);
}

// ── deleteAccount ────────────────────────────────────────────────────────────
function deleteAccount(username) {
  username = sanitizeUsername(username);
  if (userExists(username)) {
    try { execSync(`userdel -r ${username}`, { stdio: 'pipe' }); }
    catch (_) { try { execSync(`userdel ${username}`); } catch (_) {} }
  }
  const sshDir = `${HOME_BASE}/${username}/.ssh`;
  if (fs.existsSync(sshDir)) fs.rmSync(sshDir, { recursive: true, force: true });
  const accounts = readAccounts().filter(a => a.username !== username);
  writeAccounts(accounts);
  // Best-effort DB cleanup.
  (async () => {
    try {
      await pool.query('DELETE FROM dpanel_sftp_accounts WHERE username = ?', [username]);
      await pool.query('DELETE FROM dpanel_domain_keys   WHERE username = ?', [username]);
    } catch (_) {}
  })();
  logAction('access:delete', username, 'ok');
  audit(null, null, 'access:delete', null, username);
}

// ── Back-compat shims (kept for older callers in routes/ftp.js et al) ───────
function ensureSftpGroup() { ssh.ensureGroups(); }
function ensureSshdConfig() { ensureAccessConfig(); }

module.exports = {
  // Legacy
  readAccounts, writeAccounts,
  sanitizeUsername, setPassword, userExists,
  ensureSftpGroup, ensureSshdConfig,
  createAccount, deleteAccount,
  // New SSH-first API
  ensureAccessConfig,
  provisionDomainUser,
  listKeys, addKey, removeKey, rewriteAuthorizedKeysFor,
  enableFtp, disableFtp, resetFtpPassword,
};
