'use strict';
const fs   = require('fs');
const path = require('path');
const { run, runAsync, sanitizeEmail } = require('./shell');

const USERS_FILE    = '/etc/dovecot/users';
const VIRTUAL_FILE  = '/etc/postfix/virtual';
const VDOMAINS_FILE = '/etc/postfix/vdomains';
const VMAILBOX_FILE = '/etc/postfix/vmailbox';
const VMAIL_BASE    = '/var/mail/vhosts';

// ── Postfix sync helpers ───────────────────────────────────────────────────────

/**
 * Ensure the domain appears in /etc/postfix/vdomains (hash: format).
 * Rebuilds the .db and reloads Postfix only when the file changes.
 */
function ensurePostfixDomain(domain) {
  const lines  = fs.existsSync(VDOMAINS_FILE)
    ? fs.readFileSync(VDOMAINS_FILE, 'utf8').split('\n').filter(Boolean)
    : [];
  // key-value format required by postmap: "domain    OK"
  if (!lines.some(l => l.split(/\s+/)[0] === domain)) {
    fs.appendFileSync(VDOMAINS_FILE, `${domain}    OK\n`);
    run(`postmap ${VDOMAINS_FILE}`, 'mail:postmap-vdomains', domain);
    run('postfix reload', 'mail:reload-postfix', domain);
  }
}

/**
 * Remove a domain from vdomains only when no mailboxes remain for it.
 */
function prunePostfixDomain(domain) {
  const mailboxes = fs.existsSync(VMAILBOX_FILE)
    ? fs.readFileSync(VMAILBOX_FILE, 'utf8').split('\n').filter(l => l.includes(`@${domain}`))
    : [];
  if (mailboxes.length === 0) {
    const lines = fs.existsSync(VDOMAINS_FILE)
      ? fs.readFileSync(VDOMAINS_FILE, 'utf8').split('\n').filter(Boolean)
      : [];
    fs.writeFileSync(VDOMAINS_FILE, lines.filter(l => l.split(/\s+/)[0] !== domain).join('\n') + '\n');
    run(`postmap ${VDOMAINS_FILE}`, 'mail:postmap-vdomains', domain);
    run('postfix reload', 'mail:reload-postfix', domain);
  }
}

/**
 * Add mailbox entry to /etc/postfix/vmailbox and create the Maildir on disk.
 * vmailbox format: "user@domain    domain/user/Maildir/"
 */
function ensurePostfixMailbox(email) {
  const [user, domain] = email.split('@');
  const mapEntry  = `${email}    ${domain}/${user}/Maildir/\n`;
  const lines     = fs.existsSync(VMAILBOX_FILE)
    ? fs.readFileSync(VMAILBOX_FILE, 'utf8')
    : '';
  if (!lines.split('\n').some(l => l.split(/\s+/)[0] === email)) {
    fs.appendFileSync(VMAILBOX_FILE, mapEntry);
    run(`postmap ${VMAILBOX_FILE}`, 'mail:postmap-vmailbox', email);
  }
  // Create Maildir with correct ownership (vmail uid/gid 5000)
  const maildirPath = path.join(VMAIL_BASE, domain, user, 'Maildir');
  run(`mkdir -p ${maildirPath}/{cur,new,tmp}`, 'mail:mkdir', email);
  run(`chown -R vmail:vmail ${path.join(VMAIL_BASE, domain)}`, 'mail:chown', email);
}

/**
 * Remove mailbox entry from vmailbox and rebuild the hash.
 */
function removePostfixMailbox(email) {
  if (!fs.existsSync(VMAILBOX_FILE)) return;
  const lines = fs.readFileSync(VMAILBOX_FILE, 'utf8').split('\n').filter(Boolean);
  fs.writeFileSync(VMAILBOX_FILE, lines.filter(l => l.split(/\s+/)[0] !== email).join('\n') + '\n');
  run(`postmap ${VMAILBOX_FILE}`, 'mail:postmap-vmailbox', email);
}

// ── Accounts ──────────────────────────────────────────────────────────────────

function listAccounts() {
  if (!fs.existsSync(USERS_FILE)) return [];
  return fs.readFileSync(USERS_FILE, 'utf8')
    .split('\n')
    .filter(l => l.trim() && !l.startsWith('#'))
    .map(line => {
      const [email, hash, ...rest] = line.split(':');
      return { email: email.trim(), quota: rest[3] || '' };
    });
}

async function addAccount(email, password, quota) {
  sanitizeEmail(email);
  const domain = email.split('@')[1];
  const hash = await runAsync(`doveadm pw -s SHA512-CRYPT -p '${password.replace(/'/g, "'\\''")}'`, 'mail:hash-pw', email);
  const entry = `${email}:${hash.trim()}:${email.split('@')[0]}:${email.split('@')[0]}::${quota || '1G'}::userdb_quota_rule=*:bytes=${quota || '1G'}\n`;
  fs.appendFileSync(USERS_FILE, entry);
  run('systemctl reload dovecot', 'mail:reload-dovecot', email);

  // Keep Postfix in sync: domain must be accepted, mailbox must be routable
  ensurePostfixDomain(domain);
  ensurePostfixMailbox(email);
}

async function changePassword(email, password) {
  sanitizeEmail(email);
  const hash = await runAsync(`doveadm pw -s SHA512-CRYPT -p '${password.replace(/'/g, "'\\''")}'`, 'mail:hash-pw', email);
  const lines = fs.existsSync(USERS_FILE) ? fs.readFileSync(USERS_FILE, 'utf8').split('\n') : [];
  const updated = lines.map(l => l.startsWith(email + ':') ? `${email}:${hash.trim()}:${l.split(':').slice(2).join(':')}` : l);
  fs.writeFileSync(USERS_FILE, updated.join('\n'));
  run('systemctl reload dovecot', 'mail:reload-dovecot', email);
  // Ensure Postfix entry exists (idempotent — no-ops if already present)
  ensurePostfixDomain(email.split('@')[1]);
  ensurePostfixMailbox(email);
}

function deleteAccount(email) {
  sanitizeEmail(email);
  const domain = email.split('@')[1];
  // Remove from Dovecot
  const lines = fs.existsSync(USERS_FILE) ? fs.readFileSync(USERS_FILE, 'utf8').split('\n') : [];
  fs.writeFileSync(USERS_FILE, lines.filter(l => !l.startsWith(email + ':')).join('\n'));
  run('systemctl reload dovecot', 'mail:reload-dovecot', email);
  // Remove from Postfix; prune domain if last account
  removePostfixMailbox(email);
  prunePostfixDomain(domain);
}

// ── Forwards ──────────────────────────────────────────────────────────────────

/**
 * Returns true if the email address has an existing virtual mailbox entry.
 */
function hasMailbox(email) {
  if (!fs.existsSync(VMAILBOX_FILE)) return false;
  return fs.readFileSync(VMAILBOX_FILE, 'utf8')
    .split('\n')
    .some(l => l.split(/\s+/)[0] === email);
}

/**
 * Internal shadow address used so a mailbox account can also forward.
 * e.g. ben@froggystx.com → ben.keep@froggystx.com
 */
function shadowAddress(email) {
  const [user, domain] = email.split('@');
  return `${user}.keep@${domain}`;
}

function listForwards() {
  if (!fs.existsSync(VIRTUAL_FILE)) return [];
  return fs.readFileSync(VIRTUAL_FILE, 'utf8')
    .split('\n')
    .filter(l => l.trim() && !l.startsWith('#') && l.includes('@'))
    .map(line => {
      const [source, ...dests] = line.trim().split(/\s+/);
      const shadow = shadowAddress(source);
      // Strip the internal shadow address from displayed destinations
      const externalDests = dests.filter(d => d !== shadow);
      return {
        source,
        destinations: externalDests.join(', '),
        keepsLocal: dests.includes(shadow),
      };
    });
}

function addForward(source, destinations) {
  sanitizeEmail(source);
  const dests = destinations.split(',').map(d => d.trim()).filter(Boolean);
  dests.forEach(d => sanitizeEmail(d));

  // If source already has a mailbox, add a shadow vmailbox entry so mail is
  // delivered locally AND forwarded externally.
  const allDests = [...dests];
  if (hasMailbox(source)) {
    const shadow = shadowAddress(source);
    const [user, domain] = source.split('@');
    // Add shadow → same Maildir as original
    const mapEntry = `${shadow}    ${domain}/${user}/Maildir/\n`;
    const existing = fs.existsSync(VMAILBOX_FILE) ? fs.readFileSync(VMAILBOX_FILE, 'utf8') : '';
    if (!existing.split('\n').some(l => l.split(/\s+/)[0] === shadow)) {
      fs.appendFileSync(VMAILBOX_FILE, mapEntry);
      run(`postmap ${VMAILBOX_FILE}`, 'mail:postmap-vmailbox', shadow);
    }
    allDests.unshift(shadow); // local copy first, then external forwards
  }

  const entry = `${source}  ${allDests.join(', ')}\n`;
  fs.appendFileSync(VIRTUAL_FILE, entry);
  run('postmap /etc/postfix/virtual', 'mail:postmap', source);
  ensurePostfixDomain(source.split('@')[1]);
  run('systemctl reload postfix', 'mail:reload-postfix', source);
}

function deleteForward(source) {
  sanitizeEmail(source);

  // Remove shadow vmailbox entry if one was created
  const shadow = shadowAddress(source);
  if (fs.existsSync(VMAILBOX_FILE)) {
    const lines = fs.readFileSync(VMAILBOX_FILE, 'utf8').split('\n').filter(Boolean);
    const filtered = lines.filter(l => l.split(/\s+/)[0] !== shadow);
    if (filtered.length !== lines.length) {
      fs.writeFileSync(VMAILBOX_FILE, filtered.join('\n') + '\n');
      run(`postmap ${VMAILBOX_FILE}`, 'mail:postmap-vmailbox', shadow);
    }
  }

  // Remove the virtual alias
  const lines = fs.existsSync(VIRTUAL_FILE) ? fs.readFileSync(VIRTUAL_FILE, 'utf8').split('\n') : [];
  fs.writeFileSync(VIRTUAL_FILE, lines.filter(l => !l.trim().startsWith(source)).join('\n'));
  run('postmap /etc/postfix/virtual', 'mail:postmap', source);
  run('systemctl reload postfix', 'mail:reload-postfix', source);
}

// ── Quota ─────────────────────────────────────────────────────────────────────

/**
 * Update the quota for an existing mail account in /etc/dovecot/users.
 * The entry format is: email:hash:user:user::QUOTA::userdb_quota_rule=*:bytes=QUOTA
 * We update both the 6th field (plain quota) and the bytes= value.
 */
function updateQuota(email, quota) {
  sanitizeEmail(email);
  if (!quota || !/^\d+[KMGT]$/i.test(quota)) throw new Error('Invalid quota format. Use e.g. 500M, 1G, 2G');
  if (!fs.existsSync(USERS_FILE)) throw new Error('Users file not found');
  const lines = fs.readFileSync(USERS_FILE, 'utf8').split('\n');
  let found = false;
  const updated = lines.map(l => {
    if (!l.startsWith(email + ':')) return l;
    found = true;
    const parts = l.split(':');
    // parts: [email, hash, user, user, '', quota, '', userdb_quota_rule=*:bytes=QUOTA]
    parts[5] = quota;
    // Rebuild userdb_quota_rule field (index 7 onward may be merged)
    const tail = parts.slice(7).join(':');
    const newTail = tail.replace(/bytes=[^\s]+/, `bytes=${quota}`);
    return parts.slice(0, 7).join(':') + ':' + newTail;
  });
  if (!found) throw new Error(`Account not found: ${email}`);
  fs.writeFileSync(USERS_FILE, updated.join('\n'));
  run('systemctl reload dovecot', 'mail:reload-dovecot', email);
}

module.exports = { listAccounts, addAccount, changePassword, deleteAccount, updateQuota, listForwards, addForward, deleteForward };
