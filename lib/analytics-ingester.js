'use strict';
/**
 * lib/analytics-ingester.js — Background log ingestion worker
 *
 * Reads Apache access logs incrementally (cursor-based), enriches each entry
 * with bot detection + IP geolocation + visitor fingerprint, then stores to MariaDB.
 *
 * Architecture:
 *  - On start() a full historical backfill runs immediately, then a 60-second
 *    interval keeps data up to date.
 *  - Uses byte cursors (analytics_log_cursors) so each log file is processed
 *    only once per byte — no duplicate rows, safe to restart.
 *  - Inserts are batched (up to 500 rows per transaction) for performance.
 *  - Daily rollup runs once per day (checks last-rollup timestamp).
 *  - Health records are written per-domain per run to analytics_ingest_health.
 */

const fs        = require('fs');
const path      = require('path');
const readline  = require('readline');
const crypto    = require('crypto');
const botdetect = require('./botdetect');
const geo       = require('./geo');
const { pool }  = require('./db');

const LOG_DIR    = '/var/log/apache2';
const INTERVAL   = 60 * 1000;    // 60 seconds between ingestion runs
const BATCH_SIZE = 500;           // rows per DB insert batch

// In-memory rate tracker for behavioral bot detection
// ip_hash → { count: N, windowStart: timestamp }
const _rateTracker = new Map();
const RATE_LIMIT   = 20;          // requests per window
const RATE_WINDOW  = 60 * 1000;   // 60 second window

// Daily rollup tracking
let _lastRollupDate = null;

// ── Regex: Apache Combined Log Format ─────────────────────────────────────────
const LOG_RE = /^(\S+) \S+ \S+ \[([^\]]+)\] "(\S+) ([^"]*?) HTTP\/[^"]*" (\d+) (\S+)(?: "([^"]*)" "([^"]*)")?/;
const MONTH_MAP = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };
const STATIC_RE = /\.(css|js|mjs|ico|png|jpg|jpeg|gif|svg|webp|avif|bmp|woff|woff2|ttf|eot|otf|map|mp4|mp3|ogg|wav|pdf|zip|gz|tar|bz2|rar|exe|dmg|pkg|wasm|json|xml|txt|csv|rss|atom|apk)(\?.*)?$/i;
const INTERNAL_PATH_RE = /^\/(api|auth|terminal|_next|__webpack)(\/.+)?$/i;

// UTM and tracking params to strip from referrers
const UTM_PARAMS_RE = /[?&](utm_[a-z]+|fbclid|gclid|msclkid|mc_eid|yclid|zanpid|ref|source|campaign|medium|term|content|affiliate|partner|click_id|sessionid)=[^&]*/gi;

// ── Parse Apache date → UTC Date ──────────────────────────────────────────────
function parseApacheDate(str) {
  const m = str.match(/^(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-]\d{4})/);
  if (!m) return null;
  const sign  = m[7][0] === '+' ? 1 : -1;
  const offH  = parseInt(m[7].slice(1, 3), 10);
  const offM  = parseInt(m[7].slice(3, 5), 10);
  const offMs = sign * (offH * 60 + offM) * 60 * 1000;
  const local = Date.UTC(+m[3], MONTH_MAP[m[2]], +m[1], +m[4], +m[5], +m[6]);
  return new Date(local - offMs);
}

// ── Parse a single Combined Log Format line ───────────────────────────────────
function parseLine(line) {
  const m = line.match(LOG_RE);
  if (!m) return null;
  const t = parseApacheDate(m[2]);
  if (!t) return null;
  const rawUrl = m[4] || '/';
  return {
    ip:      m[1],
    time:    t,
    method:  m[3],
    url:     rawUrl.split('?')[0],
    status:  parseInt(m[5], 10),
    bytes:   m[6] === '-' ? 0 : parseInt(m[6], 10),
    referer: m[7] && m[7] !== '-' ? m[7] : '',
    ua:      m[8] || '',
  };
}

// ── Referrer normalization ────────────────────────────────────────────────────
function normalizeReferrer(referer) {
  if (!referer) return null;
  try {
    const u = new URL(referer);
    // Strip UTM and tracking query params
    const cleaned = referer.replace(UTM_PARAMS_RE, '').replace(/[?&]$/, '').replace(/\?$/, '');
    // If only the domain remains (no meaningful path), just store root domain
    const cleanUrl = new URL(cleaned.trim() || `${u.protocol}//${u.hostname}`);
    if (!cleanUrl.pathname || cleanUrl.pathname === '/') {
      return `${cleanUrl.protocol}//${cleanUrl.hostname}`;
    }
    return cleaned.trim() || `${u.protocol}//${u.hostname}`;
  } catch {
    return referer.slice(0, 2048);
  }
}

// ── Visitor fingerprint ───────────────────────────────────────────────────────
// Uses: ip + ua + daily salt (UTC date string) — privacy-respecting daily rotation
function computeFingerprint(ip, ua, date) {
  const dailySalt = date instanceof Date
    ? date.toISOString().slice(0, 10)
    : String(date).slice(0, 10);
  const input = `${ip}|${ua}|${dailySalt}`;
  return crypto.createHash('sha256').update(input).digest('hex');
}

// ── Behavioral bot detection (rate-based) ─────────────────────────────────────
function checkRateBased(ipHash, now) {
  const entry = _rateTracker.get(ipHash);
  if (!entry) {
    _rateTracker.set(ipHash, { count: 1, windowStart: now });
    return false;
  }
  if (now - entry.windowStart > RATE_WINDOW) {
    // New window
    _rateTracker.set(ipHash, { count: 1, windowStart: now });
    return false;
  }
  entry.count++;
  if (entry.count > RATE_LIMIT) return true; // flag as suspicious
  return false;
}

// Periodically clear the rate tracker to prevent unbounded growth
function clearStaleRateEntries(now) {
  for (const [key, val] of _rateTracker.entries()) {
    if (now - val.windowStart > RATE_WINDOW * 2) _rateTracker.delete(key);
  }
}

// ── Extract domain from log filename ─────────────────────────────────────────
function domainFromFile(filename) {
  return filename.replace(/_access\.log$/, '').replace(/-access\.log$/, '');
}

// ── List all log files to ingest ─────────────────────────────────────────────
function listLogFiles() {
  if (!fs.existsSync(LOG_DIR)) return [];
  return fs.readdirSync(LOG_DIR)
    .filter(f => f.endsWith('_access.log') || f.endsWith('-access.log'))
    .filter(f => !f.includes('-le-ssl') && !f.includes('000-default') && !f.startsWith('other_'))
    .filter(f => f !== 'panel_access.log' && f !== 'panel-access.log')
    .map(f => ({ file: f, fullPath: path.join(LOG_DIR, f), domain: domainFromFile(f) }));
}

// ── Cursor management ─────────────────────────────────────────────────────────
async function getCursor(filePath) {
  const [rows] = await pool.query('SELECT byte_offset FROM analytics_log_cursors WHERE log_file = ?', [filePath]);
  return rows.length ? Number(rows[0].byte_offset) : 0;
}

async function saveCursor(filePath, offset) {
  await pool.query(
    `INSERT INTO analytics_log_cursors (log_file, byte_offset) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE byte_offset = VALUES(byte_offset)`,
    [filePath, offset]
  );
}

// ── Batch insert ──────────────────────────────────────────────────────────────
async function insertBatch(rows) {
  if (!rows.length) return;
  const values = rows.map(r => [
    r.domain, r.ts, r.ip_anon, r.ip_hash, r.method,
    (r.url    || '').slice(0, 2048),   // guard: truncate over-long URLs
    r.status, r.bytes,
    (r.referrer || '').slice(0, 2048), // guard: truncate over-long referrers
    (r.ua       || '').slice(0, 512),  // guard: truncate over-long user agents
    r.traffic_type, r.bot_reason, r.country, r.region, r.city,
    r.visitor_fingerprint,
  ]);

  await pool.query(
    `INSERT INTO analytics_pageviews
       (domain, ts, ip_anon, ip_hash, method, url, status, bytes,
        referrer, ua, traffic_type, bot_reason, country, region, city,
        visitor_fingerprint)
     VALUES ?`,
    [values]
  );
}

// ── Write health record ───────────────────────────────────────────────────────
async function writeHealth(domain, linesProcessed, rowsInserted, rowsSkipped, errorMsg = null) {
  try {
    await pool.query(
      `INSERT INTO analytics_ingest_health (domain, lines_processed, rows_inserted, rows_skipped, error_msg)
       VALUES (?, ?, ?, ?, ?)`,
      [domain, linesProcessed, rowsInserted, rowsSkipped, errorMsg]
    );
  } catch (_) { /* non-fatal */ }
}

// ── Process one log file ──────────────────────────────────────────────────────
async function processFile({ fullPath, domain }) {
  if (!fs.existsSync(fullPath)) return;

  const fileSize = fs.statSync(fullPath).size;
  const cursor   = await getCursor(fullPath);

  if (cursor > fileSize) {
    await saveCursor(fullPath, 0);
    return processFile({ fullPath, domain });
  }
  if (cursor >= fileSize) return;

  const stream = fs.createReadStream(fullPath, { encoding: 'utf8', start: cursor });
  const rl     = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let bytesRead      = 0;
  let linesProcessed = 0;
  let rowsSkipped    = 0;
  let batch          = [];
  const now          = Date.now();

  for await (const line of rl) {
    bytesRead += Buffer.byteLength(line, 'utf8') + 1;
    linesProcessed++;

    const e = parseLine(line);
    if (!e) { rowsSkipped++; continue; }

    if (e.method !== 'GET' && e.method !== 'HEAD') { rowsSkipped++; continue; }
    if (STATIC_RE.test(e.url)) { rowsSkipped++; continue; }
    if (INTERNAL_PATH_RE.test(e.url)) { rowsSkipped++; continue; }

    // Bot detection: UA string first
    let { type: traffic_type, reason: bot_reason } = botdetect.classify(e.ua);

    // Geo enrichment + anonymization
    const { anon: ip_anon, hash: ip_hash } = geo.anonymizeIP(e.ip);
    const { country, region, city }         = geo.lookup(e.ip);

    // Visitor fingerprint (daily rotation, uses time from the log entry)
    const visitor_fingerprint = computeFingerprint(e.ip, e.ua, e.time);

    // Behavioral bot check (rate-based): flag as 'bot' if >20 req/min
    // (uses 'bot' to stay within ENUM('real','bot','crawler'); bot_reason='rate_limit' preserves distinction)
    if (traffic_type === 'real') {
      const isSuspicious = checkRateBased(ip_hash, e.time.getTime());
      if (isSuspicious) {
        traffic_type = 'bot';
        bot_reason   = 'rate_limit';
      }
    }

    // Referrer normalization: strip UTM params, compress to root domain when trivial
    const normalizedReferrer = normalizeReferrer(e.referer);

    batch.push({
      domain,
      ts:                  e.time,
      ip_anon,
      ip_hash,
      method:              e.method,
      url:                 e.url,
      status:              e.status,
      bytes:               e.bytes,
      referrer:            normalizedReferrer,
      ua:                  e.ua || null,
      traffic_type,
      bot_reason:          bot_reason || null,
      country:             country || null,
      region:              region  || null,
      city:                city    || null,
      visitor_fingerprint,
    });

    if (batch.length >= BATCH_SIZE) {
      await insertBatch(batch);
      batch = [];
    }
  }

  if (batch.length) await insertBatch(batch);
  await saveCursor(fullPath, cursor + bytesRead);

  // Write health record (only if we actually processed new lines)
  if (linesProcessed > 0) {
    const rowsInserted = linesProcessed - rowsSkipped - (batch.length); // approximate
    await writeHealth(domain, linesProcessed, Math.max(0, linesProcessed - rowsSkipped), rowsSkipped);
  }

  // Prune stale rate tracker entries occasionally
  clearStaleRateEntries(now);
}

// ── Daily rollup aggregation ──────────────────────────────────────────────────
async function runDailyRollup() {
  const today = new Date().toISOString().slice(0, 10);
  if (_lastRollupDate === today) return; // already ran today

  try {
    // Aggregate yesterday's data into analytics_daily_summary
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

    // Get all domains with data yesterday
    const [domains] = await pool.query(
      `SELECT DISTINCT domain FROM analytics_pageviews WHERE DATE(ts) = ?`,
      [yesterday]
    );

    for (const { domain } of domains) {
      // Real pageviews + unique visitors + sessions approximation
      const [pvRow] = await pool.query(
        `SELECT COUNT(*) AS pv,
                COUNT(DISTINCT COALESCE(visitor_fingerprint, ip_hash)) AS uv
         FROM analytics_pageviews
         WHERE domain = ? AND DATE(ts) = ? AND traffic_type = 'real'`,
        [domain, yesterday]
      );

      const [botRow] = await pool.query(
        `SELECT COUNT(*) AS bc FROM analytics_pageviews
         WHERE domain = ? AND DATE(ts) = ? AND traffic_type IN ('bot','crawler','suspicious')`,
        [domain, yesterday]
      );

      const pv = Number(pvRow[0]?.pv || 0);
      const uv = Number(pvRow[0]?.uv || 0);
      const bc = Number(botRow[0]?.bc || 0);

      if (pv === 0) continue;

      // Quick session approximation: unique visitors / 1.2 (rough heuristic for daily rollup)
      const sessions   = Math.round(uv * 1.2);
      const bounceRate = 60; // approximate; exact computation happens in full query
      const avgDur     = 0;  // approximate

      await pool.query(
        `INSERT INTO analytics_daily_summary (domain, date, pageviews, visitors, sessions, bounce_rate, avg_duration, bot_requests)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           pageviews    = VALUES(pageviews),
           visitors     = VALUES(visitors),
           sessions     = VALUES(sessions),
           bot_requests = VALUES(bot_requests)`,
        [domain, yesterday, pv, uv, sessions, bounceRate, avgDur, bc]
      );
    }

    // Update hourly rollup for yesterday
    const [hourlyRows] = await pool.query(
      `SELECT domain,
              DATE_FORMAT(ts, '%Y-%m-%d %H:00:00') AS hour,
              COUNT(*) AS pv,
              COUNT(DISTINCT COALESCE(visitor_fingerprint, ip_hash)) AS uv
       FROM analytics_pageviews
       WHERE DATE(ts) = ? AND traffic_type = 'real'
       GROUP BY domain, hour`,
      [yesterday]
    );

    for (const r of hourlyRows) {
      await pool.query(
        `INSERT INTO analytics_hourly_rollup (domain, hour, pageviews, visitors)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE pageviews = VALUES(pageviews), visitors = VALUES(visitors)`,
        [r.domain, r.hour, r.pv, r.uv]
      );
    }

    // Retention cleanup: delete raw pageviews older than 90 days
    await pool.query(
      `DELETE FROM analytics_pageviews WHERE ts < DATE_SUB(NOW(), INTERVAL 90 DAY) LIMIT 10000`
    );

    // Prune old health records older than 7 days
    await pool.query(`DELETE FROM analytics_ingest_health WHERE run_at < DATE_SUB(NOW(), INTERVAL 7 DAY)`);

    _lastRollupDate = today;
    console.log(`[analytics-ingester] Daily rollup complete for ${yesterday}`);
  } catch (err) {
    console.error('[analytics-ingester] Daily rollup error:', err.message);
  }
}

// ── Main ingestion run ────────────────────────────────────────────────────────
async function runIngestion() {
  const files = listLogFiles();
  for (const f of files) {
    try {
      await processFile(f);
    } catch (err) {
      console.error(`[analytics-ingester] Error processing ${f.file}:`, err.message);
      await writeHealth(f.domain, 0, 0, 0, err.message);
    }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────
let _timer = null;

function start() {
  if (_timer) return;

  setImmediate(async () => {
    console.log('[analytics-ingester] Starting initial log backfill...');
    try {
      await runIngestion();
      console.log('[analytics-ingester] Initial backfill complete');
      // Run rollup after backfill
      await runDailyRollup();
    } catch (err) {
      console.error('[analytics-ingester] Backfill error:', err.message);
    }
  });

  _timer = setInterval(async () => {
    try {
      await runIngestion();
      // Check if daily rollup should run (once per day)
      const hour = new Date().getUTCHours();
      if (hour === 2) await runDailyRollup(); // run at UTC 2am
    } catch (err) {
      console.error('[analytics-ingester] Run error:', err.message);
    }
  }, INTERVAL);

  console.log('[analytics-ingester] Started (interval: 60s)');
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { start, stop, runIngestion, runDailyRollup };
