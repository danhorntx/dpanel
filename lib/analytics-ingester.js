'use strict';
/**
 * lib/analytics-ingester.js — Background log ingestion worker
 *
 * Reads Apache access logs incrementally (cursor-based), enriches each entry
 * with bot detection + IP geolocation, then stores the result in MariaDB.
 *
 * Architecture:
 *  - On start() a full historical backfill runs immediately, then a 60-second
 *    interval keeps data up to date.
 *  - Uses byte cursors (analytics_log_cursors) so each log file is processed
 *    only once per byte — no duplicate rows, safe to restart.
 *  - Inserts are batched (up to 500 rows per transaction) for performance.
 *  - The DPanel admin panel log (panel_access.log) is excluded.
 */

const fs       = require('fs');
const path     = require('path');
const readline = require('readline');
const botdetect = require('./botdetect');
const geo       = require('./geo');
const { pool }  = require('./db');

const LOG_DIR   = '/var/log/apache2';
const INTERVAL  = 60 * 1000;   // 60 seconds between ingestion runs
const BATCH_SIZE = 500;         // rows per DB insert batch

// ── Regex: Apache Combined Log Format ─────────────────────────────────────────
const LOG_RE = /^(\S+) \S+ \S+ \[([^\]]+)\] "(\S+) ([^"]*?) HTTP\/[^"]*" (\d+) (\S+)(?: "([^"]*)" "([^"]*)")?/;

const MONTH_MAP = {
  Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11,
};

// Entries matching these are not page-level visits — skip them
const STATIC_RE = /\.(css|js|mjs|ico|png|jpg|jpeg|gif|svg|webp|avif|bmp|woff|woff2|ttf|eot|otf|map|mp4|mp3|ogg|wav|pdf|zip|gz|tar|bz2|rar|exe|dmg|pkg|wasm|json|xml|txt|csv|rss|atom|apk)(\?.*)?$/i;
const INTERNAL_PATH_RE = /^\/(api|auth|terminal|_next|__webpack)(\/.+)?$/i;

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

// ── Extract domain from log filename ─────────────────────────────────────────
function domainFromFile(filename) {
  return filename
    .replace(/_access\.log$/, '')
    .replace(/-access\.log$/, '');
}

// ── List all log files to ingest (excluding panel) ───────────────────────────
function listLogFiles() {
  if (!fs.existsSync(LOG_DIR)) return [];
  return fs.readdirSync(LOG_DIR)
    .filter(f => f.endsWith('_access.log') || f.endsWith('-access.log'))
    .filter(f => !f.includes('-le-ssl') && !f.includes('000-default') && !f.startsWith('other_'))
    .filter(f => f !== 'panel_access.log' && f !== 'panel-access.log')
    .map(f => ({ file: f, fullPath: path.join(LOG_DIR, f), domain: domainFromFile(f) }));
}

// ── Get stored cursor for a file ──────────────────────────────────────────────
async function getCursor(filePath) {
  const [rows] = await pool.query(
    'SELECT byte_offset FROM analytics_log_cursors WHERE log_file = ?',
    [filePath]
  );
  return rows.length ? Number(rows[0].byte_offset) : 0;
}

// ── Save cursor for a file ────────────────────────────────────────────────────
async function saveCursor(filePath, offset) {
  await pool.query(
    `INSERT INTO analytics_log_cursors (log_file, byte_offset)
     VALUES (?, ?)
     ON DUPLICATE KEY UPDATE byte_offset = VALUES(byte_offset)`,
    [filePath, offset]
  );
}

// ── Insert a batch of enriched rows into analytics_pageviews ─────────────────
async function insertBatch(rows) {
  if (!rows.length) return;
  const values = rows.map(r => [
    r.domain, r.ts, r.ip_anon, r.ip_hash, r.method, r.url, r.status, r.bytes,
    r.referrer, r.ua, r.traffic_type, r.bot_reason, r.country, r.region, r.city,
  ]);

  await pool.query(
    `INSERT INTO analytics_pageviews
       (domain, ts, ip_anon, ip_hash, method, url, status, bytes,
        referrer, ua, traffic_type, bot_reason, country, region, city)
     VALUES ?`,
    [values]
  );
}

// ── Process one log file from its current cursor position ─────────────────────
async function processFile({ fullPath, domain }) {
  if (!fs.existsSync(fullPath)) return;

  const fileSize  = fs.statSync(fullPath).size;
  const cursor    = await getCursor(fullPath);

  // File was rotated / truncated — reset cursor
  if (cursor > fileSize) {
    await saveCursor(fullPath, 0);
    return processFile({ fullPath, domain });
  }

  if (cursor >= fileSize) return; // nothing new

  const stream = fs.createReadStream(fullPath, { encoding: 'utf8', start: cursor });
  const rl     = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let bytesRead = 0;
  let batch     = [];

  for await (const line of rl) {
    bytesRead += Buffer.byteLength(line, 'utf8') + 1; // +1 for newline

    const e = parseLine(line);
    if (!e) continue;

    // Skip non-page entries
    if (e.method !== 'GET' && e.method !== 'HEAD') continue;
    if (e.status >= 400) continue;
    if (STATIC_RE.test(e.url)) continue;
    if (INTERNAL_PATH_RE.test(e.url)) continue;

    // Bot detection
    const { type: traffic_type, reason: bot_reason } = botdetect.classify(e.ua);

    // Geo enrichment
    const { anon: ip_anon, hash: ip_hash } = geo.anonymizeIP(e.ip);
    const { country, region, city }         = geo.lookup(e.ip);

    batch.push({
      domain,
      ts:           e.time,
      ip_anon,
      ip_hash,
      method:       e.method,
      url:          e.url,
      status:       e.status,
      bytes:        e.bytes,
      referrer:     e.referer || null,
      ua:           e.ua || null,
      traffic_type,
      bot_reason:   bot_reason || null,
      country:      country || null,
      region:       region  || null,
      city:         city    || null,
    });

    if (batch.length >= BATCH_SIZE) {
      await insertBatch(batch);
      batch = [];
    }
  }

  if (batch.length) await insertBatch(batch);
  await saveCursor(fullPath, cursor + bytesRead);
}

// ── Main ingestion run: process all files ─────────────────────────────────────
async function runIngestion() {
  const files = listLogFiles();
  for (const f of files) {
    try {
      await processFile(f);
    } catch (err) {
      console.error(`[analytics-ingester] Error processing ${f.file}:`, err.message);
    }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────
let _timer = null;

function start() {
  if (_timer) return; // already running

  // Kick off immediately (backfill all historical data), then poll
  setImmediate(async () => {
    console.log('[analytics-ingester] Starting initial log backfill...');
    try {
      await runIngestion();
      console.log('[analytics-ingester] Initial backfill complete');
    } catch (err) {
      console.error('[analytics-ingester] Backfill error:', err.message);
    }
  });

  _timer = setInterval(async () => {
    try { await runIngestion(); }
    catch (err) { console.error('[analytics-ingester] Run error:', err.message); }
  }, INTERVAL);

  console.log('[analytics-ingester] Started (interval: 60s)');
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { start, stop, runIngestion };
