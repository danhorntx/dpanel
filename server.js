'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express       = require('express');
const https         = require('https');
const http          = require('http');
const fs            = require('fs');
const path          = require('path');
const helmet        = require('helmet');
const session       = require('express-session');
const MySQLStore    = require('express-mysql-session')(session);
const cron          = require('node-cron');
const WebSocket     = require('ws');
const { requireLogin }   = require('./lib/auth');
const { attachTerminal } = require('./routes/terminal');
const { pool, migrate }  = require('./lib/db');
const ingester           = require('./lib/analytics-ingester');

const CERT_DIR = path.join(__dirname, 'certs');
const PORT     = process.env.PORT || 8080;

// ── App setup ─────────────────────────────────────────────────────────────────
const app = express();

// Security headers (helmet) — applied before everything else
// CSP is relaxed enough for the panel's inline scripts/styles
app.use(helmet({
  contentSecurityPolicy: false, // dashboard uses inline scripts — we'll tighten this later
  crossOriginEmbedderPolicy: false,
}));
app.use((req, res, next) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Session store (MariaDB-backed) ────────────────────────────────────────────
const sessionStore = new MySQLStore({
  schema: {
    tableName:   'dpanel_sessions',
    columnNames: {
      session_id: 'session_id',
      expires:    'expires',
      data:       'data',
    },
  },
  createDatabaseTable:     true,
  clearExpired:            true,
  checkExpirationInterval: 15 * 60 * 1000,
  expiration:               8 * 60 * 60 * 1000,
}, pool);

const sessionMiddleware = session({
  secret:            process.env.SESSION_SECRET, // required — checked in db.js startup
  resave:            false,
  saveUninitialized: false,
  store:             sessionStore,
  cookie: {
    secure:   true,
    httpOnly: true,
    maxAge:   8 * 60 * 60 * 1000,
    sameSite: 'strict',
  },
});
app.use(sessionMiddleware);

// Static files (no auth on login page / assets)
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth routes (public) ──────────────────────────────────────────────────────
app.use('/auth', require('./routes/auth'));

// ── Protected API routes ──────────────────────────────────────────────────────
app.use('/api/dashboard',   requireLogin, require('./routes/dashboard'));
app.use('/api/domains',     requireLogin, require('./routes/domains'));
app.use('/api/dns',         requireLogin, require('./routes/dns'));
app.use('/api/mail',        requireLogin, require('./routes/mail'));
app.use('/api/ssl',         requireLogin, require('./routes/ssl'));
app.use('/api/logs',        requireLogin, require('./routes/logs'));
app.use('/api/settings',    requireLogin, require('./routes/settings'));
app.use('/api/ftp',         requireLogin, require('./routes/ftp'));
app.use('/api/php',         requireLogin, require('./routes/php'));
app.use('/api/mysql',       requireLogin, require('./routes/mysql'));
app.use('/api/cron',        requireLogin, require('./routes/cron'));
app.use('/api/backup',      requireLogin, require('./routes/backup'));
app.use('/api/firewall',    requireLogin, require('./routes/firewall'));
app.use('/api/wordpress',   requireLogin, require('./routes/wordpress'));
app.use('/api/git',         requireLogin, require('./routes/git'));
app.use('/api/files',       requireLogin, require('./routes/files'));
app.use('/api/healthcheck', requireLogin, require('./routes/healthcheck'));
app.use('/api/users',       requireLogin, require('./routes/users'));
app.use('/api/analytics',   requireLogin, require('./routes/analytics'));
app.use('/webmail',                       require('./routes/webmail'));

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

// ── Boot: run DB migration then start listening ───────────────────────────────
migrate()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`[DPanel] Listening on port ${PORT}`);
    });
    ingester.start();
  })
  .catch(err => {
    console.error('[DPanel] DB migration failed — aborting:', err.message);
    process.exit(1);
  });
