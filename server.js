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
const { requireLogin, acceptApiKey }   = require('./lib/auth');
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

// ── API key auth — runs before every /api/* route. If a valid `Authorization:
//    Bearer dpk_...` header is present, stamps req.apiAuth so requireLogin/
//    requireAdmin accept it as a valid session. No-op if no key.
app.use('/api', acceptApiKey);

// ── Protected API routes ──────────────────────────────────────────────────────
app.use('/api/dashboard',   requireLogin, require('./routes/dashboard'));
app.use('/api/domains',     requireLogin, require('./routes/domains'));
app.use('/api/domains',     requireLogin, require('./routes/access'));   // /:domain/access/* — SSH-first key+FTP mgmt
app.use('/api/matomo',      requireLogin, require('./routes/matomo'));   // Matomo analytics bridge
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
app.use('/api/keys',        requireLogin, require('./routes/apikeys'));
app.use('/api/apps',        requireLogin, require('./routes/apps'));
app.use('/api/jobs',        requireLogin, require('./routes/jobs'));
app.use('/api/analytics',         requireLogin, require('./routes/analytics'));
app.use('/api/analytics/reports', requireLogin, require('./routes/analytics-reports'));
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
attachTerminal(wss, sessionStore, process.env.SESSION_SECRET);

// ── Analytics report mailer cron (runs at 7am UTC daily) ─────────────────────
cron.schedule('0 7 * * *', async () => {
  try {
    const mailer = require('./lib/analytics-mailer');
    await mailer.checkAndSendDueReports();
  } catch (err) {
    console.error('[cron] analytics report error:', err.message);
  }
});

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

// ── Matomo analytics DB backup (daily 2:30 AM) ────────────────────────────────
// Reuses lib/backup.js's backupMatomo() so backups land in the same
// /opt/dpanel/backups dir as every other DPanel backup. cleanup() then
// keeps the last N per the same retention rules. The hourly archive
// command (separate from this — runs core:archive inside the container)
// is installed via system crontab in scripts/install-matomo-cron.sh.
cron.schedule('30 2 * * *', async () => {
  try {
    const backup = require('./lib/backup');
    if (!require('fs').existsSync('/opt/matomo/.env')) return;   // matomo not installed
    const r = await backup.backupMatomo();
    console.log(`[cron] matomo backup: ${r.file}`);
    const removed = backup.cleanup(14);   // keep last 14 days
    if (removed > 0) console.log(`[cron] matomo backup cleanup: removed ${removed} stale backups`);
  } catch (err) {
    console.error('[cron] matomo backup failed:', err.message);
  }
});

// ── SSL retry cron (every 15 min) ─────────────────────────────────────────────
// Picks up domains in dpanel_domain_settings.ssl_retry_state='pending' and
// retries any host whose H+1/H+5/H+13/H+25 retry window has come due.
cron.schedule('*/15 * * * *', async () => {
  try {
    const sslretry = require('./lib/sslretry');
    const r = await sslretry.runDueRetries();
    if (r.retried > 0) console.log(`[cron] ssl-retry: retried ${r.retried} host(s) across ${r.domains} domain(s)`);
  } catch (err) {
    console.error('[cron] ssl-retry failed:', err.message);
  }
});

// ── Mail health probe cron (daily at 4am UTC) ─────────────────────────────────
// Runs the deliverability probe for every managed zone that has DKIM, stores
// results in dpanel_mail_health for trending. UI shows the most recent. When
// summary degrades to 'fail', an alert email goes to the admin.
cron.schedule('0 4 * * *', async () => {
  try {
    const mailhealth = require('./lib/mailhealth');
    const dnsLib     = require('./lib/dns');
    const dkim       = require('./lib/dkim');
    const notify     = require('./lib/notify');
    const zones      = dnsLib.listZones();
    const targets    = zones.map(z => z.domain).filter(d => dkim.hasDkim(d));
    if (!targets.length) return;
    console.log(`[cron] mail-health probing ${targets.length} domain(s)`);
    for (const d of targets) {
      try {
        const result = await mailhealth.checkDomain(d);
        await pool.query(
          'INSERT INTO dpanel_mail_health (domain, summary, server_ip, helo_hostname, result_json) VALUES (?, ?, ?, ?, ?)',
          [result.domain, result.summary, result.server_ip, result.helo_hostname, JSON.stringify(result)]
        );
        // Alert on failing probes — dedupe key includes domain so each
        // newly-broken domain triggers its own notification, but the same
        // domain failing day after day only emails once per 24h.
        if (result.summary === 'fail') {
          const failures = result.checks.filter(c => c.status === 'fail');
          const body = `Mail Health probe for ${d} is failing.\n\n` +
            failures.map(c => `  ✗ ${c.name}: ${c.detail || '(no detail)'}`).join('\n') +
            `\n\nFull dashboard: panel → Mail → Health → ${d}`;
          notify.sendAlert({
            key:     `mail-health-fail:${d}`,
            subject: `[DPanel] Mail Health failing for ${d}`,
            body,
          }).catch(() => {});
        }
      } catch (err) {
        console.error(`[cron] mail-health for ${d} failed:`, err.message);
      }
    }
  } catch (err) {
    console.error('[cron] mail-health batch failed:', err.message);
  }
});

// ── DMARC report processor (daily at 4:30am UTC) ──────────────────────────────
// Reads the configured DMARC inbox (DMARC_INBOX_EMAIL/PASSWORD in .env),
// parses + stores any unseen aggregate reports. No-op if not configured.
cron.schedule('30 4 * * *', async () => {
  try {
    const dmarc  = require('./lib/dmarcprocessor');
    const result = await dmarc.processInbox();
    if (!result.configured) {
      console.log(`[cron] dmarc: ${result.reason} — skipping`);
      return;
    }
    console.log(`[cron] dmarc: ${result.messages} message(s), ${result.reports} report(s) ingested${result.errors.length ? ', ' + result.errors.length + ' errors' : ''}`);
  } catch (err) {
    console.error('[cron] dmarc processor failed:', err.message);
  }
});

// ── SSL expiry alert cron (daily at 5am UTC) ──────────────────────────────────
// Walks the Let's Encrypt cert list, emails on each cert with < 14 days
// remaining. Dedupe key includes the cert name so each cert generates a
// daily reminder until it's renewed.
cron.schedule('0 5 * * *', async () => {
  try {
    const ssl    = require('./lib/ssl');
    const notify = require('./lib/notify');
    const certs  = ssl.listCerts().filter(c => c.type === "Let's Encrypt");
    for (const c of certs) {
      if (c.daysLeft != null && c.daysLeft <= 14) {
        const urgent = c.daysLeft <= 3 ? '⚠️ URGENT — ' : '';
        notify.sendAlert({
          key:     `ssl-expiry:${c.domain}`,
          subject: `${urgent}[DPanel] SSL cert for ${c.domain} expires in ${c.daysLeft} day${c.daysLeft === 1 ? '' : 's'}`,
          body:    `The Let's Encrypt certificate for ${c.domain} expires on ${c.expiry}.\n\n` +
                   `Days remaining: ${c.daysLeft}\n\n` +
                   `certbot renew should handle this automatically (runs daily at 3am UTC). ` +
                   `If you're seeing this, the auto-renew likely failed — check journalctl -u dpanel ` +
                   `for "cron:ssl-renew" errors, or run "certbot renew --cert-name ${c.domain}" by hand.`,
        }).catch(() => {});
      }
    }
  } catch (err) {
    console.error('[cron] ssl-expiry alert failed:', err.message);
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
