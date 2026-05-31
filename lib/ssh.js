'use strict';
/**
 * lib/ssh.js — SSH key + sshd_config plumbing for the Add Domain SSH-first
 * rewrite.
 *
 * Responsibilities (kept narrow):
 *   - Generate ed25519 keypairs in tmpfs (/dev/shm) and return them in memory,
 *     never persisting the private key to disk.
 *   - Parse and fingerprint pasted public keys.
 *   - Manage /home/<user>/.ssh/authorized_keys atomically.
 *   - Maintain a single Apache-style block in
 *     /etc/ssh/sshd_config.d/dpanel-access.conf describing the two access
 *     groups DPanel manages:
 *
 *         Match Group dpanel-sftp     — chrooted SFTP, KEY-only (default for
 *                                       new SSH-first domains)
 *         Match Group dpanel-ftp      — chrooted SFTP, password allowed
 *                                       (opt-in FTP fallback)
 *         Match Group dpanel-shell    — full shell + key auth, no chroot
 *                                       (when allowShell=true)
 *
 *     All three groups disable TCP/X11 forwarding. Password auth on the
 *     dpanel-sftp group is explicitly off.
 *
 * Higher-level user lifecycle (useradd / chpasswd / quota / etc.) lives in
 * lib/access.js, which calls into this module.
 */

const fs           = require('fs');
const path         = require('path');
const crypto       = require('crypto');
const { execSync, spawnSync } = require('child_process');

const SSHD_DROPIN = '/etc/ssh/sshd_config.d/dpanel-access.conf';
const TMPFS_DIR   = '/dev/shm';

// ── Reserved usernames — never assignable to a domain ────────────────────────
// Includes system users, common service accounts, and DPanel internals.
const RESERVED_USERNAMES = new Set([
  'root', 'daemon', 'bin', 'sys', 'sync', 'games', 'man', 'lp', 'mail',
  'news', 'uucp', 'proxy', 'www-data', 'backup', 'list', 'irc', 'gnats',
  'nobody', 'systemd-network', 'systemd-resolve', 'systemd-timesync',
  'messagebus', 'syslog', '_apt', 'tss', 'uuidd', 'tcpdump', 'sshd',
  'landscape', 'pollinate', 'ec2-instance-connect',
  'mysql', 'postfix', 'postdrop', 'dovecot', 'dovenull', 'opendkim',
  'apache', 'apache2', 'nginx', 'redis', 'memcache', 'rabbitmq',
  'ubuntu', 'admin', 'administrator', 'test', 'guest', 'oracle',
  'dpanel', 'dpanel-sftp', 'dpanel-ftp', 'dpanel-shell',
]);

function isReservedUsername(name) {
  return RESERVED_USERNAMES.has((name || '').toLowerCase());
}

// ── Keypair generation (tmpfs-only — private key never hits real disk) ──────
/**
 * Generate an ed25519 keypair in /dev/shm. The keypair files are deleted
 * before this function returns; the caller receives them only in memory.
 *
 * @param {object} [opts]
 * @param {string} [opts.comment]   - SSH comment field (defaults to "dpanel-generated")
 * @returns {{ privateKey:string, publicKey:string, fingerprint:string, keyType:'ssh-ed25519' }}
 */
function generateKeypair(opts = {}) {
  const comment = (opts.comment || 'dpanel-generated').replace(/[^a-zA-Z0-9@._+-]/g, '');
  // /dev/shm is tmpfs so the private key never touches persistent storage.
  // Best-effort: fall back to mkdtempSync in /tmp if shm isn't mounted.
  const baseDir = fs.existsSync(TMPFS_DIR) ? TMPFS_DIR : '/tmp';
  const tmp     = path.join(baseDir, `dpanel-keygen-${crypto.randomBytes(8).toString('hex')}`);

  try {
    const r = spawnSync('ssh-keygen',
      ['-t', 'ed25519', '-f', tmp, '-N', '', '-C', comment, '-q'],
      { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr || 'ssh-keygen failed');

    const privateKey = fs.readFileSync(tmp, 'utf8');
    const publicKey  = fs.readFileSync(tmp + '.pub', 'utf8').trim();
    const fingerprint = fingerprintOf(publicKey);

    return { privateKey, publicKey, fingerprint, keyType: 'ssh-ed25519' };
  } finally {
    try { fs.unlinkSync(tmp); }          catch (_) {}
    try { fs.unlinkSync(tmp + '.pub'); } catch (_) {}
  }
}

// ── Pasted-key validation + fingerprint ─────────────────────────────────────
/**
 * Validate a single pasted authorized_keys line. Accepts ssh-ed25519,
 * ssh-rsa, ecdsa-sha2-nistp{256,384,521}.  Strips leading options (e.g.
 * `command="..." ssh-rsa AAAA...`) — those would let a key bypass our
 * ForceCommand and we want to control that ourselves.
 *
 * @param {string} raw
 * @returns {{ keyType:string, body:string, comment:string, normalized:string, fingerprint:string }}
 * @throws  if the line doesn't parse or uses an unsupported key type.
 */
function parsePublicKey(raw) {
  if (!raw || typeof raw !== 'string') throw new Error('Public key required.');
  // Squash any leading options (anything before the first whitespace-separated key-type token).
  const cleaned = raw.replace(/\r/g, '').trim().split('\n')[0];
  const tokens  = cleaned.split(/\s+/);
  const typeIdx = tokens.findIndex(t => /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521))$/.test(t));
  if (typeIdx === -1) throw new Error('Unsupported or malformed public key — expected ssh-ed25519, ssh-rsa, or ecdsa-sha2-nistp*.');

  const keyType = tokens[typeIdx];
  const body    = tokens[typeIdx + 1];
  const comment = tokens.slice(typeIdx + 2).join(' ');
  if (!body || !/^[A-Za-z0-9+/=]+$/.test(body)) throw new Error('Malformed public key body — base64 expected.');

  const normalized = comment ? `${keyType} ${body} ${comment}` : `${keyType} ${body}`;
  return {
    keyType,
    body,
    comment,
    normalized,
    fingerprint: fingerprintOf(normalized),
  };
}

/**
 * Compute the SHA256 fingerprint of a public key in the same format that
 * `ssh-keygen -lf` produces (e.g. "SHA256:abc123…"). Works by writing the
 * key to a temp file (ssh-keygen has no stdin mode for this) and reading
 * the column from its output.
 */
function fingerprintOf(publicKey) {
  const tmp = path.join('/dev/shm', `dpanel-fp-${crypto.randomBytes(6).toString('hex')}.pub`);
  try {
    fs.writeFileSync(tmp, publicKey + '\n');
    const out = execSync(`ssh-keygen -lf ${tmp}`, { encoding: 'utf8' });
    const m   = out.match(/\bSHA256:[A-Za-z0-9+/=]+/);
    if (!m) throw new Error('Could not compute fingerprint.');
    return m[0];
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

// ── authorized_keys management ──────────────────────────────────────────────
/**
 * Atomically rewrite /home/<username>/.ssh/authorized_keys with the given
 * normalized key lines. The .ssh dir + file are chmod 700 / 600, owned by
 * the user. Caller is responsible for sequencing this after `useradd`.
 *
 * @param {string}   username
 * @param {string[]} keys   - normalized authorized_keys lines (one per element)
 */
function writeAuthorizedKeys(username, keys) {
  if (!/^[a-z][a-z0-9_-]*$/.test(username)) throw new Error('Invalid username.');
  const home   = `/home/${username}`;
  const sshDir = `${home}/.ssh`;
  const akPath = `${sshDir}/authorized_keys`;

  fs.mkdirSync(sshDir, { recursive: true });
  const body = (keys || []).map(k => k.trim()).filter(Boolean).join('\n');
  // Atomic write: tmp file, fsync-equivalent rename.
  const tmp = `${akPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, body ? body + '\n' : '', { mode: 0o600 });
  fs.renameSync(tmp, akPath);
  execSync(`chmod 700 ${sshDir}`);
  execSync(`chmod 600 ${akPath}`);
  try { execSync(`chown -R ${username}:${username} ${sshDir}`); } catch (_) {}
}

// ── sshd_config drop-in ─────────────────────────────────────────────────────
/**
 * Ensure /etc/ssh/sshd_config.d/dpanel-access.conf describes the three
 * access groups DPanel manages. Safe to call repeatedly — only writes if
 * the file is missing or differs. Reloads sshd on change.
 *
 * Chroot requirements:
 *   - /home/<user> must be root-owned mode 755 (the chroot jail dir).
 *   - The user's writable workspace lives at /home/<user>/<docroot subdir>.
 *   lib/access.js handles those invariants when provisioning the user.
 */
function ensureSshdDropin() {
  const desired = `# Managed by DPanel — do not edit manually
# Three access tiers for DPanel-managed users. Each user belongs to
# EXACTLY ONE of these groups (lib/access.js enforces mutual exclusivity).
# OpenSSH's "first match wins" semantics means double-grouping would let
# the most restrictive block apply unexpectedly.
#
#   dpanel-sftp   — SSH-first default: chrooted SFTP, KEY-only. Used for
#                   new domains whose docroot is /home/<user>/public_html
#                   so the chroot at /home/%u contains the writable site.
#   dpanel-ftp    — Legacy / adopted domains AND opt-in FTP fallback.
#                   SFTP-forced (no shell), NOT chrooted, password+key.
#                   These users typically have docroot at /var/www/<domain>
#                   which lives outside any /home jail.
#   dpanel-shell  — Full bash shell, key-only, no chroot. Replaces sftp/ftp
#                   group membership when shell is enabled.
#
# Authorized keys live at /home/<user>/.ssh/authorized_keys.

AuthorizedKeysFile .ssh/authorized_keys /home/%u/.ssh/authorized_keys

Match Group dpanel-sftp
    ChrootDirectory /home/%u
    ForceCommand internal-sftp
    PasswordAuthentication no
    PubkeyAuthentication yes
    AllowTcpForwarding no
    X11Forwarding no

Match Group dpanel-ftp
    ForceCommand internal-sftp
    PasswordAuthentication yes
    PubkeyAuthentication yes
    AllowTcpForwarding no
    X11Forwarding no

Match Group dpanel-shell
    PasswordAuthentication no
    PubkeyAuthentication yes
    AllowTcpForwarding no
    X11Forwarding no
`;
  const current = fs.existsSync(SSHD_DROPIN) ? fs.readFileSync(SSHD_DROPIN, 'utf8') : '';
  if (current === desired) return false;
  fs.writeFileSync(SSHD_DROPIN, desired, { mode: 0o644 });
  // configtest before reload — sshd reload of a broken config will kick everyone.
  try { execSync('sshd -t', { stdio: 'pipe' }); }
  catch (err) {
    // Roll back to the previous file so we don't break SSH for the panel itself.
    if (current) fs.writeFileSync(SSHD_DROPIN, current);
    else         fs.unlinkSync(SSHD_DROPIN);
    throw new Error(`sshd_config drop-in failed validation: ${err.stderr?.toString() || err.message}`);
  }
  try { execSync('systemctl reload ssh || systemctl reload sshd'); } catch (_) {}
  return true;
}

/**
 * Ensure the three Linux groups (dpanel-sftp, dpanel-ftp, dpanel-shell)
 * exist. Idempotent.
 */
function ensureGroups() {
  for (const g of ['dpanel-sftp', 'dpanel-ftp', 'dpanel-shell']) {
    try { execSync(`getent group ${g}`, { stdio: 'pipe' }); }
    catch (_) { execSync(`groupadd ${g}`); }
  }
}

module.exports = {
  RESERVED_USERNAMES,
  isReservedUsername,
  generateKeypair,
  parsePublicKey,
  fingerprintOf,
  writeAuthorizedKeys,
  ensureSshdDropin,
  ensureGroups,
};
