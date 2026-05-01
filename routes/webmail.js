'use strict';
const express  = require('express');
const path     = require('path');
const crypto   = require('crypto');
const imap     = require('../lib/imap');
const smtp     = require('../lib/smtp');
const router   = express.Router();

const SESSION_SECRET = process.env.SESSION_SECRET || 'dpanel-session-secret-change-me';

// ── Credential encryption (AES-256-GCM) ──────────────────────────────────────
function encryptCreds(creds, sessionId) {
  const key    = crypto.scryptSync(sessionId + SESSION_SECRET, 'dpanel-webmail', 32);
  const iv     = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc    = Buffer.concat([cipher.update(JSON.stringify(creds), 'utf8'), cipher.final()]);
  const tag    = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decryptCreds(token, sessionId) {
  const buf     = Buffer.from(token, 'base64');
  const iv      = buf.slice(0, 12);
  const tag     = buf.slice(12, 28);
  const enc     = buf.slice(28);
  const key     = crypto.scryptSync(sessionId + SESSION_SECRET, 'dpanel-webmail', 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8'));
}

function getCredentials(req) {
  if (!req.session.webmailToken) return null;
  try { return decryptCreds(req.session.webmailToken, req.sessionID); }
  catch (_) { return null; }
}

// ── Serve webmail SPA ─────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'webmail.html'));
});
router.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'webmail.html'));
});

// ── Login ─────────────────────────────────────────────────────────────────────
router.post('/api/login', async (req, res) => {
  try {
    const { email, password, host, port, secure, smtpHost, smtpPort } = req.body;
    if (!email || !password) return res.json({ success: false, error: 'Email and password required' });
    const creds = {
      email, password,
      host:     host     || '127.0.0.1',
      port:     port     || 993,
      secure:   secure   !== false,
      smtpHost: smtpHost || '127.0.0.1',
      smtpPort: smtpPort || 587,
    };
    // Verify connection
    await imap.listMailboxes(creds);
    req.session.webmailToken = encryptCreds(creds, req.sessionID);
    res.json({ success: true, email });
  } catch (err) {
    res.json({ success: false, error: 'Authentication failed: ' + err.message });
  }
});

router.post('/api/logout', (req, res) => {
  delete req.session.webmailToken;
  res.json({ success: true });
});

router.get('/api/me', (req, res) => {
  const creds = getCredentials(req);
  if (!creds) return res.json({ success: false, error: 'Not logged in' });
  res.json({ success: true, email: creds.email });
});

// ── Mailboxes ─────────────────────────────────────────────────────────────────
router.get('/api/mailboxes', async (req, res) => {
  const creds = getCredentials(req);
  if (!creds) return res.status(401).json({ success: false, error: 'Not logged in to webmail' });
  try {
    res.json({ success: true, data: await imap.listMailboxes(creds) });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// ── Messages ──────────────────────────────────────────────────────────────────
router.get('/api/messages', async (req, res) => {
  const creds = getCredentials(req);
  if (!creds) return res.status(401).json({ success: false, error: 'Not logged in to webmail' });
  try {
    const mailbox = req.query.mailbox || 'INBOX';
    const page    = parseInt(req.query.page) || 1;
    const result  = await imap.listMessages(creds, mailbox, page, 25);
    res.json({ success: true, data: result });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

router.get('/api/messages/:uid', async (req, res) => {
  const creds = getCredentials(req);
  if (!creds) return res.status(401).json({ success: false, error: 'Not logged in to webmail' });
  try {
    const mailbox = req.query.mailbox || 'INBOX';
    const msg     = await imap.getMessage(creds, mailbox, req.params.uid);
    if (!msg) return res.json({ success: false, error: 'Message not found' });
    res.json({ success: true, data: msg });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

router.delete('/api/messages/:uid', async (req, res) => {
  const creds = getCredentials(req);
  if (!creds) return res.status(401).json({ success: false, error: 'Not logged in to webmail' });
  try {
    const mailbox = req.query.mailbox || 'INBOX';
    await imap.deleteMessage(creds, mailbox, req.params.uid);
    res.json({ success: true });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// ── Mark read / unread ────────────────────────────────────────────────────────
router.patch('/api/messages/:uid/flags', async (req, res) => {
  const creds = getCredentials(req);
  if (!creds) return res.status(401).json({ success: false, error: 'Not logged in to webmail' });
  try {
    const mailbox  = req.query.mailbox || 'INBOX';
    const { flag, add } = req.body;
    if (!flag) return res.json({ success: false, error: 'flag is required' });
    await imap.setMessageFlags(creds, mailbox, req.params.uid, [flag], add !== false);
    res.json({ success: true });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// ── Compose / Send ────────────────────────────────────────────────────────────
router.post('/api/send', async (req, res) => {
  const creds = getCredentials(req);
  if (!creds) return res.status(401).json({ success: false, error: 'Not logged in to webmail' });
  try {
    const { to, subject, text, html, replyTo, cc, bcc, draftUid, inReplyTo, references } = req.body;
    if (!to || !subject) return res.json({ success: false, error: 'To and subject are required' });

    // Send and capture raw RFC822 for Sent folder copy
    const { raw } = await smtp.sendMail(creds, {
      to, subject, text, html, replyTo, cc, bcc, inReplyTo, references,
    });

    // Append copy to Sent folder (non-fatal if it fails)
    const sentFolder = await imap.findFolder(creds,
      ['Sent', 'Sent Items', 'Sent Messages', 'INBOX.Sent', 'INBOX/Sent']);
    if (sentFolder) {
      try {
        await imap.appendToFolder(creds, sentFolder, raw, ['\\Seen']);
      } catch (appendErr) {
        console.warn('[webmail] Sent APPEND failed:', appendErr.message);
      }
    } else {
      console.warn('[webmail] No Sent folder found — skipping Sent copy');
    }

    // Delete draft if message was composed from one
    if (draftUid) {
      const draftsFolder = await imap.findFolder(creds,
        ['Drafts', 'Draft', 'INBOX.Drafts', 'INBOX/Drafts']);
      if (draftsFolder) {
        try { await imap.deleteMessage(creds, draftsFolder, draftUid); } catch (_) {}
      }
    }

    res.json({ success: true });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// ── Drafts ────────────────────────────────────────────────────────────────────
router.post('/api/draft', async (req, res) => {
  const creds = getCredentials(req);
  if (!creds) return res.status(401).json({ success: false, error: 'Not logged in to webmail' });
  try {
    const { to, subject, text, cc, bcc, oldUid } = req.body;

    const raw = await smtp.buildRaw({
      from:    creds.email,
      to:      to      || '',
      cc:      cc      || undefined,
      bcc:     bcc     || undefined,
      subject: subject || '(no subject)',
      text:    text    || '',
    });

    const draftsFolder = await imap.findFolder(creds,
      ['Drafts', 'Draft', 'INBOX.Drafts', 'INBOX/Drafts']);
    if (!draftsFolder) return res.json({ success: false, error: 'No Drafts folder found' });

    // Delete old draft before saving replacement
    if (oldUid) {
      try { await imap.deleteMessage(creds, draftsFolder, oldUid); } catch (_) {}
    }

    const result = await imap.appendToFolder(creds, draftsFolder, raw, ['\\Draft', '\\Seen']);
    res.json({ success: true, uid: result?.uid || null });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

router.delete('/api/draft/:uid', async (req, res) => {
  const creds = getCredentials(req);
  if (!creds) return res.status(401).json({ success: false, error: 'Not logged in to webmail' });
  try {
    const draftsFolder = await imap.findFolder(creds,
      ['Drafts', 'Draft', 'INBOX.Drafts', 'INBOX/Drafts']);
    if (!draftsFolder) return res.json({ success: false, error: 'No Drafts folder found' });
    await imap.deleteMessage(creds, draftsFolder, req.params.uid);
    res.json({ success: true });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

module.exports = router;
