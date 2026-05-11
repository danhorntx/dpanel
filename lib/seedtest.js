'use strict';
/**
 * lib/seedtest.js — Send a tagged test message to real seed inboxes, then
 * read each one back to see if the message landed in inbox or spam.
 *
 * This is the truth signal that probes can't give. SPF/DKIM/DMARC can all
 * pass while Gmail still spam-folders you for reputation reasons. Only a
 * real send-and-check tells you.
 *
 * Configuration: seed inboxes are listed in env vars, one set per provider:
 *
 *   DPANEL_SEED_GMAIL=user@gmail.com
 *   DPANEL_SEED_GMAIL_PASSWORD=<app-password>     (must be an App Password,
 *                                                  not the account password)
 *   DPANEL_SEED_OUTLOOK=user@outlook.com
 *   DPANEL_SEED_OUTLOOK_PASSWORD=<app-password>
 *   DPANEL_SEED_YAHOO=user@yahoo.com
 *   DPANEL_SEED_YAHOO_PASSWORD=<app-password>
 *
 * Any subset works. Missing creds → that provider is skipped, not failed.
 *
 * The test:
 *   1. Generate unique tag → goes in Subject + X-DPanel-SeedTest header.
 *   2. Send via local Postfix (DKIM-signed by OpenDKIM on the way out).
 *   3. Wait `propagationWaitMs` (default 2 min) for mail to land.
 *   4. For each configured seed, IMAP-search Inbox and Spam folders for tag.
 *   5. Record landed=inbox/spam/missing per seed.
 *
 * Returns a structured result. The route layer is responsible for kicking
 * this off as a background job (lib/jobqueue) since the wait is long.
 */

const crypto      = require('crypto');
const nodemailer  = require('nodemailer');
const { ImapFlow } = require('imapflow');
const { pool }    = require('./db');
const { execSync } = require('child_process');

const PROVIDERS = [
  { name: 'gmail',   env: 'DPANEL_SEED_GMAIL',   imap: { host: 'imap.gmail.com',     port: 993 }, spamFolders: ['[Gmail]/Spam', 'Spam'] },
  { name: 'outlook', env: 'DPANEL_SEED_OUTLOOK', imap: { host: 'outlook.office365.com', port: 993 }, spamFolders: ['Junk Email', 'Junk'] },
  { name: 'yahoo',   env: 'DPANEL_SEED_YAHOO',   imap: { host: 'imap.mail.yahoo.com', port: 993 }, spamFolders: ['Bulk Mail', 'Spam'] },
];

function _configuredSeeds() {
  return PROVIDERS
    .map(p => ({
      ...p,
      email:    process.env[p.env],
      password: process.env[p.env + '_PASSWORD'],
    }))
    .filter(p => p.email && p.password);
}

function _generateTag() {
  return `seedtest-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

function _hostname() {
  try { return execSync('hostname -f', { encoding: 'utf8', timeout: 2000 }).trim(); }
  catch (_) { return 'localhost'; }
}

async function _sendTestMail(tag, fromAddress, seeds) {
  const transporter = nodemailer.createTransport({
    host:   '127.0.0.1',
    port:   25,
    secure: false,
    tls:    { rejectUnauthorized: false },
  });
  await transporter.sendMail({
    from:    fromAddress,
    to:      seeds.map(s => s.email).join(', '),
    subject: `[DPanel deliverability test] ${tag}`,
    text:    `This is an automated deliverability test from DPanel.\n\nTag: ${tag}\nSent: ${new Date().toISOString()}\n\nYou can safely delete or ignore this message.\n`,
    headers: { 'X-DPanel-SeedTest': tag },
  });
}

async function _checkOneSeed(seed, tag) {
  const client = new ImapFlow({
    host: seed.imap.host,
    port: seed.imap.port,
    secure: true,
    auth: { user: seed.email, pass: seed.password },
    logger: false,
  });
  try {
    await client.connect();
    // Try inbox first
    const checkFolder = async (folderName) => {
      try {
        await client.mailboxOpen(folderName);
        const uids = await client.search({ subject: tag });
        return Array.isArray(uids) && uids.length > 0;
      } catch (_) { return false; }
    };
    if (await checkFolder('INBOX')) return { landed: 'inbox', folder: 'INBOX' };
    for (const f of seed.spamFolders) {
      if (await checkFolder(f)) return { landed: 'spam', folder: f };
    }
    return { landed: 'missing', folder: null };
  } catch (err) {
    return { landed: 'error', folder: null, error: err.message };
  } finally {
    try { await client.logout(); } catch (_) {}
  }
}

/**
 * Run a full seed test for a domain. Designed to be invoked from a job
 * queue worker because it sleeps ~2 minutes between send and check.
 *
 * @param {string} domain        — which domain to send from (admin@<domain> or postmaster@<domain>)
 * @param {object} opts
 * @param {number} [opts.propagationWaitMs] — default 120_000
 * @param {object} [opts.job]    — optional jobqueue handle for progress updates
 * @returns {Promise<{tag, domain, from_address, seeds, status}>}
 */
async function runTest(domain, { propagationWaitMs = 120_000, job = null } = {}) {
  const seeds = _configuredSeeds();
  if (!seeds.length) {
    return {
      domain,
      status: 'failed',
      error:  'No seed accounts configured. Set DPANEL_SEED_GMAIL{,_PASSWORD} etc. in /opt/dpanel/.env.',
      seeds:  [],
    };
  }

  const tag         = _generateTag();
  const fromAddress = `postmaster@${domain || _hostname()}`;
  job?.setProgress(10, `Sending tagged message to ${seeds.length} seed(s)…`);

  try {
    await _sendTestMail(tag, fromAddress, seeds);
  } catch (err) {
    return { domain, status: 'failed', error: `Send failed: ${err.message}`, tag, from_address: fromAddress, seeds: [] };
  }

  // Record send
  await pool.query(
    'INSERT INTO dpanel_seed_tests (domain, tag, from_address, status) VALUES (?, ?, ?, ?)',
    [domain, tag, fromAddress, 'sent']
  );

  job?.setProgress(30, `Waiting ${Math.round(propagationWaitMs/1000)}s for mail to propagate…`);
  await new Promise(r => setTimeout(r, propagationWaitMs));

  job?.setProgress(70, `Checking ${seeds.length} seed inbox(es)…`);
  const results = [];
  for (const seed of seeds) {
    const r = await _checkOneSeed(seed, tag);
    results.push({ provider: seed.name, email: seed.email, ...r });
  }

  await pool.query(
    'UPDATE dpanel_seed_tests SET status = ?, checked_at = NOW(), results_json = ? WHERE tag = ?',
    ['complete', JSON.stringify(results), tag]
  );

  job?.setProgress(100, 'Done');
  return { tag, domain, from_address: fromAddress, seeds: results, status: 'complete' };
}

async function recentTests(limit = 30) {
  const cap = Math.min(Math.max(parseInt(limit, 10) || 30, 1), 200);
  const [rows] = await pool.query(
    `SELECT id, domain, tag, from_address, sent_at, checked_at, status, results_json
       FROM dpanel_seed_tests
       ORDER BY sent_at DESC
       LIMIT ?`,
    [cap]
  );
  return rows;
}

function configuredSeeds() {
  return _configuredSeeds().map(p => ({ provider: p.name, email: p.email }));
}

module.exports = { runTest, recentTests, configuredSeeds };
