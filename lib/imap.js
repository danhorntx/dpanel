'use strict';
const fs              = require('fs');
const { ImapFlow }    = require('imapflow');
const { simpleParser } = require('mailparser');   // SEC-QA: moved to top of module

// ── TLS servername resolution for loopback IMAP ───────────────────────────────
// When ImapFlow connects to 127.0.0.1 Node's TLS stack validates the cert
// against the IP, which never matches a real cert CN/SAN. We pass an SNI
// `servername` so validation works against a real hostname.
//
// Resolution order (per-user, evaluated at connect time):
//   1. Per-domain: if a Let's Encrypt cert exists for mail.<email-domain>,
//      use that hostname. Requires Dovecot SNI registration (see lib/dovecot.js).
//   2. Env fallback: IMAP_LOCAL_SERVERNAME, set to whatever single cert
//      Dovecot's default ssl_cert directive serves.
//   3. Safe loopback: rejectUnauthorized=false. Cannot be intercepted on
//      127.0.0.1 so still safe; used when no cert is available yet.
const IMAP_LOCAL_SERVERNAME = process.env.IMAP_LOCAL_SERVERNAME !== undefined
  ? process.env.IMAP_LOCAL_SERVERNAME
  : '';

function _pickPerDomainServername(email) {
  if (!email || typeof email !== 'string' || !email.includes('@')) return null;
  const domain = email.split('@')[1].toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(domain)) return null; // defensive — sanitize
  const certPath = `/etc/letsencrypt/live/mail.${domain}/fullchain.pem`;
  return fs.existsSync(certPath) ? `mail.${domain}` : null;
}

function makeClient(creds) {
  const host    = creds.host || '127.0.0.1';
  const isLocal = host === '127.0.0.1' || host === 'localhost';

  let tlsOpts = creds.tls ? { ...creds.tls } : {};
  if (isLocal && !tlsOpts.servername) {
    const perDomain = _pickPerDomainServername(creds.email);
    if (perDomain) {
      tlsOpts.servername = perDomain;
    } else if (IMAP_LOCAL_SERVERNAME) {
      tlsOpts.servername = IMAP_LOCAL_SERVERNAME;
    } else {
      tlsOpts.rejectUnauthorized = false;
    }
  }

  return new ImapFlow({
    host,
    port:   creds.port || 993,
    secure: creds.secure !== false,
    auth:   { user: creds.email, pass: creds.password },
    tls:    Object.keys(tlsOpts).length ? tlsOpts : undefined,
    logger: false,
  });
}

// ── List mailboxes ────────────────────────────────────────────────────────────
async function listMailboxes(creds) {
  const client = makeClient(creds);
  await client.connect();
  const list = await client.list();
  await client.logout();
  return list.map(m => ({ path: m.path, name: m.name, flags: [...(m.flags || [])] }));
}

// ── Get unread count for a mailbox without opening it ─────────────────────────
// UX-01: new function — used by the folder sidebar to show unread badges
async function getMailboxStatus(creds, mailboxPath) {
  const client = makeClient(creds);
  await client.connect();
  try {
    const status = await client.status(mailboxPath, { messages: true, unseen: true });
    return { messages: status?.messages || 0, unseen: status?.unseen || 0 };
  } catch {
    return { messages: 0, unseen: 0 };
  } finally {
    await client.logout();
  }
}

// ── List messages in a mailbox ────────────────────────────────────────────────
async function listMessages(creds, mailbox = 'INBOX', page = 1, perPage = 25) {
  const client = makeClient(creds);
  await client.connect();
  const lock = await client.getMailboxLock(mailbox);
  try {
    const total = client.mailbox.exists;
    const from  = Math.max(1, total - (page * perPage) + 1);
    const to    = Math.max(1, total - ((page - 1) * perPage));
    if (total === 0) return { messages: [], total: 0, page, perPage };
    const range = `${from}:${to}`;
    const msgs  = [];
    for await (const msg of client.fetch(range, { envelope: true, flags: true, bodyStructure: false })) {
      msgs.push({
        uid:     msg.uid,
        seq:     msg.seq,
        subject: msg.envelope?.subject || '(no subject)',
        from:    msg.envelope?.from?.[0]?.address || '',
        date:    msg.envelope?.date,
        flags:   [...(msg.flags || [])],
        seen:    msg.flags?.has('\\Seen') || false,
      });
    }
    msgs.reverse(); // newest first
    return { messages: msgs, total, page, perPage };
  } finally {
    lock.release();
    await client.logout();
  }
}

// ── Search messages ───────────────────────────────────────────────────────────
// FEAT-03: server-side IMAP SEARCH
async function searchMessages(creds, mailbox = 'INBOX', query = '') {
  const client = makeClient(creds);
  await client.connect();
  const lock = await client.getMailboxLock(mailbox);
  try {
    const q = query.trim();
    if (!q) return { messages: [], total: 0 };

    // Search subject, from, and body
    let uids = [];
    try {
      uids = await client.search(
        { or: [{ subject: q }, { from: q }, { to: q }] },
        { uid: true }
      );
    } catch {
      // Fallback: subject + from only (some servers don't support OR)
      try { uids = await client.search({ subject: q }, { uid: true }); } catch { uids = []; }
    }

    if (!uids || uids.length === 0) return { messages: [], total: 0 };

    const msgs = [];
    for await (const msg of client.fetch(uids, { envelope: true, flags: true }, { uid: true })) {
      msgs.push({
        uid:     msg.uid,
        seq:     msg.seq,
        subject: msg.envelope?.subject || '(no subject)',
        from:    msg.envelope?.from?.[0]?.address || '',
        date:    msg.envelope?.date,
        flags:   [...(msg.flags || [])],
        seen:    msg.flags?.has('\\Seen') || false,
      });
    }
    msgs.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
    return { messages: msgs, total: msgs.length };
  } finally {
    lock.release();
    await client.logout();
  }
}

// ── Fetch a single message body ───────────────────────────────────────────────
async function getMessage(creds, mailbox, uid) {
  const client = makeClient(creds);
  await client.connect();
  const lock = await client.getMailboxLock(mailbox);
  try {
    const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
    if (!msg) return null;
    const parsed = await simpleParser(msg.source);
    // Mark as read
    await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });

    // Extract spam score from X-Spam-Status header
    const spamStatus = parsed.headers?.get('x-spam-status') || null;
    let spamScore = null, spamFlag = null;
    if (spamStatus) {
      const scoreMatch = spamStatus.match(/score=(-?[\d.]+)/i);
      const flagMatch  = spamStatus.match(/^(Yes|No)\b/i);
      if (scoreMatch) spamScore = parseFloat(scoreMatch[1]);
      if (flagMatch)  spamFlag  = flagMatch[1].toLowerCase() === 'yes';
    }

    return {
      uid,
      messageId:   parsed.messageId || '',
      subject:     parsed.subject || '(no subject)',
      from:        parsed.from?.text || '',
      to:          parsed.to?.text || '',
      cc:          parsed.cc?.text || '',
      date:        parsed.date,
      text:        parsed.text || '',
      html:        parsed.html || '',
      attachments: (parsed.attachments || []).map((a, idx) => ({
        idx,
        filename:    a.filename || `attachment-${idx}`,
        contentType: a.contentType,
        size:        a.size,
      })),
      spamScore,
      spamFlag,
    };
  } finally {
    lock.release();
    await client.logout();
  }
}

// ── Download a specific attachment ────────────────────────────────────────────
// FEAT-01: new function — re-parses message to extract attachment content
async function getAttachment(creds, mailbox, uid, idx) {
  const client = makeClient(creds);
  await client.connect();
  const lock = await client.getMailboxLock(mailbox);
  try {
    const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
    if (!msg) return null;
    const parsed = await simpleParser(msg.source);
    const att    = parsed.attachments?.[parseInt(idx, 10)];
    if (!att) return null;
    return {
      filename:    att.filename || `attachment-${idx}`,
      contentType: att.contentType || 'application/octet-stream',
      content:     att.content, // Buffer
    };
  } finally {
    lock.release();
    await client.logout();
  }
}

// ── Move message to Trash (or permanently delete if already in Trash) ─────────
// BUG-03: replaces hard-delete; tries candidate Trash folder names first
async function trashMessage(creds, mailbox, uid) {
  const TRASH_NAMES = ['Trash', '[Gmail]/Trash', 'Deleted Items', 'Deleted Messages'];
  const trashPath   = await findFolder(creds, TRASH_NAMES);

  const isAlreadyTrash = trashPath &&
    trashPath.toLowerCase() === mailbox.toLowerCase();

  if (trashPath && !isAlreadyTrash) {
    // Move to Trash
    await moveMessage(creds, mailbox, uid, trashPath);
  } else {
    // Already in Trash, or no Trash folder found — permanent delete
    await deleteMessage(creds, mailbox, uid);
  }
}

// ── Hard-delete a message (expunge) ──────────────────────────────────────────
async function deleteMessage(creds, mailbox, uid) {
  const client = makeClient(creds);
  await client.connect();
  const lock = await client.getMailboxLock(mailbox);
  try {
    await client.messageDelete(String(uid), { uid: true });
  } finally {
    lock.release();
    await client.logout();
  }
}

// ── Move message to another mailbox ──────────────────────────────────────────
// FEAT-04: also used by trashMessage and UI move-to-folder
async function moveMessage(creds, mailbox, uid, destMailbox) {
  const client = makeClient(creds);
  await client.connect();
  const lock = await client.getMailboxLock(mailbox);
  try {
    await client.messageMove(String(uid), destMailbox, { uid: true });
  } finally {
    lock.release();
    await client.logout();
  }
}

// ── Find a folder by trying candidate names ───────────────────────────────────
async function findFolder(creds, candidates) {
  const client = makeClient(creds);
  await client.connect();
  const list = await client.list();
  await client.logout();
  for (const name of candidates) {
    const match = list.find(m =>
      m.path.toLowerCase() === name.toLowerCase() ||
      m.name.toLowerCase() === name.toLowerCase()
    );
    if (match) return match.path;
  }
  return null;
}

// ── Append a raw RFC822 message to a folder ───────────────────────────────────
async function appendToFolder(creds, folderPath, rawMessage, flags = []) {
  const client = makeClient(creds);
  await client.connect();
  try {
    const result = await client.append(folderPath, rawMessage, flags, new Date());
    return result || {};
  } finally {
    await client.logout();
  }
}

// ── Add or remove IMAP flags on a message ────────────────────────────────────
async function setMessageFlags(creds, mailbox, uid, flags, add = true) {
  const client = makeClient(creds);
  await client.connect();
  const lock = await client.getMailboxLock(mailbox);
  try {
    if (add) {
      await client.messageFlagsAdd(String(uid), flags, { uid: true });
    } else {
      await client.messageFlagsRemove(String(uid), flags, { uid: true });
    }
  } finally {
    lock.release();
    await client.logout();
  }
}

module.exports = {
  listMailboxes, getMailboxStatus,
  listMessages, searchMessages,
  getMessage, getAttachment,
  trashMessage, deleteMessage, moveMessage,
  findFolder, appendToFolder, setMessageFlags,
};
