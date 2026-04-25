'use strict';
const fs = require('fs');
const { run, runAsync, sanitizeEmail } = require('./shell');

const USERS_FILE    = '/etc/dovecot/users';
const VIRTUAL_FILE  = '/etc/postfix/virtual';

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
  const hash = await runAsync(`doveadm pw -s SHA512-CRYPT -p '${password.replace(/'/g, "'\\''")}'`, 'mail:hash-pw', email);
  const entry = `${email}:${hash.trim()}:${email.split('@')[0]}:${email.split('@')[0]}::${quota || '1G'}::userdb_quota_rule=*:bytes=${quota || '1G'}\n`;
  fs.appendFileSync(USERS_FILE, entry);
  run('systemctl reload dovecot', 'mail:reload-dovecot', email);
}

async function changePassword(email, password) {
  sanitizeEmail(email);
  const hash = await runAsync(`doveadm pw -s SHA512-CRYPT -p '${password.replace(/'/g, "'\\''")}'`, 'mail:hash-pw', email);
  const lines = fs.existsSync(USERS_FILE) ? fs.readFileSync(USERS_FILE, 'utf8').split('\n') : [];
  const updated = lines.map(l => l.startsWith(email + ':') ? `${email}:${hash.trim()}:${l.split(':').slice(2).join(':')}` : l);
  fs.writeFileSync(USERS_FILE, updated.join('\n'));
  run('systemctl reload dovecot', 'mail:reload-dovecot', email);
}

function deleteAccount(email) {
  sanitizeEmail(email);
  const lines = fs.existsSync(USERS_FILE) ? fs.readFileSync(USERS_FILE, 'utf8').split('\n') : [];
  fs.writeFileSync(USERS_FILE, lines.filter(l => !l.startsWith(email + ':')).join('\n'));
  run('systemctl reload dovecot', 'mail:reload-dovecot', email);
}

// ── Forwards ──────────────────────────────────────────────────────────────────

function listForwards() {
  if (!fs.existsSync(VIRTUAL_FILE)) return [];
  return fs.readFileSync(VIRTUAL_FILE, 'utf8')
    .split('\n')
    .filter(l => l.trim() && !l.startsWith('#') && l.includes('@'))
    .map(line => {
      const [source, ...dests] = line.trim().split(/\s+/);
      return { source, destinations: dests.join(', ') };
    });
}

function addForward(source, destinations) {
  sanitizeEmail(source);
  const dests = destinations.split(',').map(d => d.trim()).filter(Boolean);
  dests.forEach(d => sanitizeEmail(d));
  const entry = `${source}  ${dests.join(', ')}\n`;
  fs.appendFileSync(VIRTUAL_FILE, entry);
  run('postmap /etc/postfix/virtual', 'mail:postmap', source);
  run('systemctl reload postfix', 'mail:reload-postfix', source);
}

function deleteForward(source) {
  sanitizeEmail(source);
  const lines = fs.existsSync(VIRTUAL_FILE) ? fs.readFileSync(VIRTUAL_FILE, 'utf8').split('\n') : [];
  fs.writeFileSync(VIRTUAL_FILE, lines.filter(l => !l.trim().startsWith(source)).join('\n'));
  run('postmap /etc/postfix/virtual', 'mail:postmap', source);
  run('systemctl reload postfix', 'mail:reload-postfix', source);
}

module.exports = { listAccounts, addAccount, changePassword, deleteAccount, listForwards, addForward, deleteForward };
