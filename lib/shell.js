'use strict';
const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, '..', 'logs', 'panel.log');

function logAction(action, target, result) {
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    action,
    target: target || '',
    result: result || 'ok'
  }) + '\n';
  try { fs.appendFileSync(LOG_FILE, entry); } catch (_) {}
}

// Sanitize a domain name — only allow safe chars
function sanitizeDomain(domain) {
  if (!/^[a-zA-Z0-9.\-_]+$/.test(domain)) {
    throw new Error(`Invalid domain name: ${domain}`);
  }
  return domain;
}

// Sanitize an email address
function sanitizeEmail(email) {
  if (!/^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(email)) {
    throw new Error(`Invalid email address: ${email}`);
  }
  return email;
}

// Sanitize a filesystem path — prevent traversal
function sanitizePath(p) {
  const resolved = path.resolve(p);
  // Must start with / and not contain ..
  if (!resolved.startsWith('/') || p.includes('..')) {
    throw new Error(`Invalid path: ${p}`);
  }
  return resolved;
}

// Synchronous exec with logging
function run(cmd, actionLabel, target) {
  try {
    const out = execSync(cmd, { encoding: 'utf8', timeout: 30000 });
    logAction(actionLabel, target, 'ok');
    return out;
  } catch (err) {
    const msg = err.stderr || err.message || String(err);
    logAction(actionLabel, target, `error: ${msg.slice(0, 200)}`);
    throw new Error(msg.slice(0, 500));
  }
}

// Async exec with logging
function runAsync(cmd, actionLabel, target) {
  return new Promise((resolve, reject) => {
    exec(cmd, { encoding: 'utf8', timeout: 120000 }, (err, stdout, stderr) => {
      if (err) {
        logAction(actionLabel, target, `error: ${(stderr || err.message).slice(0, 200)}`);
        return reject(new Error((stderr || err.message).slice(0, 500)));
      }
      logAction(actionLabel, target, 'ok');
      resolve(stdout);
    });
  });
}

module.exports = { run, runAsync, sanitizeDomain, sanitizeEmail, sanitizePath, logAction };
