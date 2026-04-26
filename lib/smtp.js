'use strict';
const nodemailer = require('nodemailer');

// ── Send via SMTP (local Postfix) ─────────────────────────────────────────────
async function sendMail(creds, { to, subject, text, html, replyTo }) {
  const transporter = nodemailer.createTransport({
    host:   creds.smtpHost || '127.0.0.1',
    port:   creds.smtpPort || 587,
    secure: false,
    auth:   { user: creds.email, pass: creds.password },
    tls:    { rejectUnauthorized: false },
  });

  await transporter.sendMail({
    from:    creds.email,
    to,
    subject,
    text,
    html,
    replyTo: replyTo || creds.email,
  });
}

module.exports = { sendMail };
