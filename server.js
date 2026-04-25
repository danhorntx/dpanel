'use strict';
const express       = require('express');
const https         = require('https');
const http          = require('http');
const fs            = require('fs');
const path          = require('path');
const session       = require('express-session');
const cron          = require('node-cron');
const WebSocket     = require('ws');
const { requireLogin } = require('./lib/auth');
const { attachTerminal } = require('./routes/terminal');

const CONFIG_FILE = path.join(__dirname, 'config.json');
const CERT_DIR    = path.join(__dirname, 'certs');
const PORT        = process.env.PORT || 8080;

// ── Load config ───────────────────────────────────────────────────────────────
let config = {};
if (fs.existsSync(CONFIG_FILE)) {
  try { config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (_) {}
}

// ── App setup ─────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session
const sessionMiddleware = session({
  secret: config.sessionSecret || 'dpanel-changeme-' + Math.random(),
  resave: false,
  saveUninitialized: false,
  cookie: { secure: true, httpOnly: true, maxAge: 8 * 60 * 60 * 1000, sameSite: 'strict' }
});
app.use(sessionMiddleware);

// Static files (no auth on login page / assets)
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth routes (public) ──────────────────────────────────────────────────────
app.use('/auth', require('./routes/auth'));

// ── Protected API routes ──────────────────────────────────────────────────────
app.use('/api/dashboard', requireLogin, require('./routes/dashboard'));
app.use('/api/domains',   requireLogin, require('./routes/domains'));
app.use('/api/mail',      requireLogin, require('./routes/mail'));
app.use('/api/ssl',       requireLogin, require('./routes/ssl'));
app.use('/api/logs',      requireLogin, require('./routes/logs'));

// Authenticated HTML pages
app.get('/dashboard', requireLogin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// ── HTTPS server ──────────────────────────────────────────────────────────────
const certFile = path.join(CERT_DIR, 'dpanel.crt');
const keyFile  = path.join(CERT_DIR, 'dpanel.key');

let server;
if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
  server = https.createServer({ cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) }, app);
  console.log('[DPanel] Starting with HTTPS');
} else {
  server = http.createServer(app);
  console.log('[DPanel] WARNING: No certs found — starting with HTTP. Run install.sh to generate certs.');
}

// ── WebSocket terminal ────────────────────────────────────────────────────────
const wss = new WebSocket.Server({ server, path: '/terminal' });
attachTerminal(wss, sessionMiddleware);

// ── SSL renewal cron ──────────────────────────────────────────────────────────
cron.schedule('0 3 * * *', async () => {
  console.log('[cron] Running certbot renew...');
  try {
    const { runAsync } = require('./lib/shell');
    await runAsync('certbot renew --non-interactive', 'cron:ssl-renew', 'all');
    console.log('[cron] certbot renew complete');
  } catch (err) {
    console.error('[cron] certbot renew failed:', err.message);
  }
});

server.listen(PORT, () => {
  console.log(`[DPanel] Listening on port ${PORT}`);
});
