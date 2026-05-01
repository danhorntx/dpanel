'use strict';
const nodemailer   = require('nodemailer');
const MailComposer = require('nodemailer/lib/mail-composer');

// ── Build a raw RFC822 message buffer (for IMAP APPEND) ───────────────────────
async function buildRaw(mailOptions) {
  return new Promise((resolve, reject) => {
    new MailComposer(mailOptions).compile().build((err, buf) =>
      err ? reject(err) : resolve(buf)
    );
  });
}

// ── Send via SMTP (local Postfix) ─────────────────────────────────────────────
async function sendMail(creds, { to, subject, text, html, replyTo, cc, bcc, inReplyTo, references }) {
  const transporter = nodemailer.createTransport({
    host:   creds.smtpHost || '127.0.0.1',
    port:   creds.smtpPort || 587,
    secure: false,
    auth:   { user: creds.email, pass: creds.password },
    tls:    { rejectUnauthorized: false },
  });

  const options = {
    from:       creds.email,
    to,
    cc:         cc         || undefined,
    bcc:        bcc        || undefined,
    subject,
    text,
    html,
    replyTo:    replyTo    || creds.email,
    inReplyTo:  inReplyTo  || undefined,
    references: references || undefined,
  };

  // Build raw RFC822 for Sent folder copy (same content, slightly different Message-ID is acceptable)
  const raw = await buildRaw(options);

  await transporter.sendMail(options);
  return { raw };
}

module.exports = { sendMail, buildRaw };
