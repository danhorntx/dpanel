'use strict';
const { ImapFlow } = require('imapflow');

// ── Build ImapFlow client from stored credentials ─────────────────────────────
function makeClient(creds) {
  return new ImapFlow({
    host:   creds.host || '127.0.0.1',
    port:   creds.port || 993,
    secure: creds.secure !== false,
    auth: { user: creds.email, pass: creds.password },
    tls:  { rejectUnauthorized: false },
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

// ── List messages in a mailbox ────────────────────────────────────────────────
async function listMessages(creds, mailbox = 'INBOX', page = 1, perPage = 25) {
  const client = makeClient(creds);
  await client.connect();
  const lock = await client.getMailboxLock(mailbox);
  try {
    const total  = client.mailbox.exists;
    const from   = Math.max(1, total - (page * perPage) + 1);
    const to     = Math.max(1, total - ((page - 1) * perPage));
    if (total === 0) return { messages: [], total: 0, page, perPage };
    const range  = `${from}:${to}`;
    const msgs   = [];
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

// ── Fetch a single message body ───────────────────────────────────────────────
async function getMessage(creds, mailbox, uid) {
  const client = makeClient(creds);
  await client.connect();
  const lock = await client.getMailboxLock(mailbox);
  try {
    const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
    if (!msg) return null;
    const { simpleParser } = require('mailparser');
    const parsed = await simpleParser(msg.source);
    // Mark as read
    await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
    return {
      uid,
      subject:     parsed.subject || '(no subject)',
      from:        parsed.from?.text || '',
      to:          parsed.to?.text || '',
      date:        parsed.date,
      text:        parsed.text || '',
      html:        parsed.html || '',
      attachments: (parsed.attachments || []).map(a => ({ filename: a.filename, contentType: a.contentType, size: a.size })),
    };
  } finally {
    lock.release();
    await client.logout();
  }
}

// ── Delete/move a message ─────────────────────────────────────────────────────
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

module.exports = { listMailboxes, listMessages, getMessage, deleteMessage, moveMessage };
