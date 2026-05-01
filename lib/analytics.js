'use strict';
/**
 * lib/analytics.js — DAnalytics query layer
 *
 * Primary path: queries the analytics_pageviews MariaDB table (populated by
 * lib/analytics-ingester.js) — provides bot filtering, geographic breakdown,
 * and fast aggregations.
 *
 * Fallback path: if the DB has no data yet for the requested domain + date range
 * (e.g. right after first install before the ingester has run), falls back to
 * live log-file streaming. The fallback does NOT include bot detection or geo.
 *
 * ── Public API ─────────────────────────────────────────────────────────────────
 *
 *   listLogDomains() → string[]
 *
 *   getStats(domain, from, to, granularity, trafficType) → StatsResult
 *     domain      : 'all' | specific domain name
 *     from/to     : Date
 *     granularity : 'hourly' | 'daily' | 'weekly' | 'monthly'
 *     trafficType : 'all' | 'real' | 'bot' | 'crawler'   (default: 'real')
 *
 *   getGeoStats(domain, from, to, trafficType) → GeoResult
 *     Returns country / region / city breakdowns from DB.
 *
 *   getRealtime(domain) → { activeVisitors: number }
 */

const fs       = require('fs');
const path     = require('path');
const readline = require('readline');
const { pool } = require('./db');

const LOG_DIR = '/var/log/apache2';

// ── Shared helpers (also used by analytics-ingester.js) ──────────────────────

const LOG_RE = /^(\S+) \S+ \S+ \[([^\]]+)\] "(\S+) ([^"]*?) HTTP\/[^"]*" (\d+) (\S+)(?: "([^"]*)" "([^"]*)")?/;
const MONTH_MAP = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };
const STATIC_RE = /\.(css|js|mjs|ico|png|jpg|jpeg|gif|svg|webp|avif|bmp|woff|woff2|ttf|eot|otf|map|mp4|mp3|ogg|wav|pdf|zip|gz|tar|bz2|rar|exe|dmg|pkg|wasm|json|xml|txt|csv|rss|atom|apk)(\?.*)?$/i;
const INTERNAL_PATH_RE = /^\/(api|auth|terminal|_next|__webpack)(\/.+)?$/i;

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

function parseLine(line) {
  const m = line.match(LOG_RE);
  if (!m) return null;
  const t = parseApacheDate(m[2]);
  if (!t) return null;
  const rawUrl = m[4] || '/';
  return {
    ip: m[1], time: t, method: m[3], url: rawUrl.split('?')[0],
    status: parseInt(m[5], 10), bytes: m[6] === '-' ? 0 : parseInt(m[6], 10),
    referer: m[7] && m[7] !== '-' ? m[7] : '', ua: m[8] || '',
  };
}

function parseUA(ua) {
  let device = 'Desktop';
  if (/mobile|iphone|ipod|android.*mobile|windows phone|blackberry|opera mini|iemobile/i.test(ua)) device = 'Mobile';
  else if (/ipad|android(?!.*mobile)|tablet|kindle|silk|playbook/i.test(ua)) device = 'Tablet';
  else if (/bot|crawler|spider|slurp|bingbot|googlebot|curl|wget|python-requests|python\/|java\/|go-http|axios|node-fetch|httpie|libwww/i.test(ua)) device = 'Bot';

  let browser = 'Other';
  if      (/edg\//i.test(ua))                    browser = 'Edge';
  else if (/opr\/|opera\//i.test(ua))            browser = 'Opera';
  else if (/samsungbrowser/i.test(ua))           browser = 'Samsung';
  else if (/chromium/i.test(ua))                 browser = 'Chromium';
  else if (/chrome\/\d/i.test(ua))               browser = 'Chrome';
  else if (/firefox\/\d/i.test(ua))              browser = 'Firefox';
  else if (/version\/[\d.]+ safari/i.test(ua))   browser = 'Safari';
  else if (/msie|trident/i.test(ua))             browser = 'IE';
  else if (/curl/i.test(ua))                     browser = 'curl';

  let os = 'Other';
  if      (/windows nt/i.test(ua))               os = 'Windows';
  else if (/cros/i.test(ua))                     os = 'ChromeOS';
  else if (/macintosh|mac os x/i.test(ua))       os = 'macOS';
  else if (/android/i.test(ua))                  os = 'Android';
  else if (/iphone|ipad|ipod/i.test(ua))         os = 'iOS';
  else if (/linux/i.test(ua))                    os = 'Linux';

  return { device, browser, os };
}

function classifySource(referer) {
  if (!referer) return { source: 'Direct', refDomain: '' };
  let host = '';
  try { host = new URL(referer).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return { source: 'Direct', refDomain: '' }; }
  if (/google\.|bing\.|yahoo\.|duckduckgo\.|baidu\.|yandex\.|ecosia\.|startpage\.|qwant\.|brave\.com|search\./.test(host)) return { source: 'Organic Search', refDomain: host };
  if (/facebook\.|fb\.com|twitter\.|x\.com|t\.co|instagram\.|linkedin\.|youtube\.|youtu\.be|tiktok\.|reddit\.|pinterest\.|snapchat\.|mastodon\./.test(host)) return { source: 'Social', refDomain: host };
  if (host) return { source: 'Referral', refDomain: host };
  return { source: 'Direct', refDomain: '' };
}

function getLogFiles(domain) {
  if (!fs.existsSync(LOG_DIR)) return [];
  const all = fs.readdirSync(LOG_DIR);
  if (domain && domain !== 'all') {
    return [path.join(LOG_DIR, `${domain}_access.log`), path.join(LOG_DIR, `${domain}-access.log`)].filter(f => fs.existsSync(f));
  }
  return all
    .filter(f => (f.endsWith('_access.log') || f.endsWith('-access.log')))
    .filter(f => !f.includes('-le-ssl') && !f.includes('000-default') && !f.startsWith('other_'))
    .filter(f => f !== 'panel_access.log' && f !== 'panel-access.log')
    .map(f => path.join(LOG_DIR, f));
}

// ── Domain listing (filesystem) ───────────────────────────────────────────────
function listLogDomains() {
  if (!fs.existsSync(LOG_DIR)) return [];
  return fs.readdirSync(LOG_DIR)
    .filter(f => f.endsWith('_access.log') || f.endsWith('-access.log'))
    .filter(f => !f.includes('-le-ssl') && !f.includes('000-default') && !f.startsWith('other_'))
    .filter(f => f !== 'panel_access.log' && f !== 'panel-access.log')
    .map(f => f.replace(/_access\.log$/, '').replace(/-access\.log$/, ''))
    .sort();
}

// ── Time bucketing helpers ────────────────────────────────────────────────────
function timeBucket(date, granularity) {
  const d = new Date(date);
  switch (granularity) {
    case 'hourly':  d.setUTCMinutes(0, 0, 0); break;
    case 'weekly':  { const dow = d.getUTCDay(); d.setUTCDate(d.getUTCDate() - dow); d.setUTCHours(0, 0, 0, 0); break; }
    case 'monthly': d.setUTCDate(1); d.setUTCHours(0, 0, 0, 0); break;
    default:        d.setUTCHours(0, 0, 0, 0);
  }
  return d.toISOString();
}

function fillTimeGaps(map, from, to, granularity) {
  const result = [];
  const cursor = new Date(from);
  switch (granularity) {
    case 'hourly':  cursor.setUTCMinutes(0, 0, 0); break;
    case 'weekly':  { const dow = cursor.getUTCDay(); cursor.setUTCDate(cursor.getUTCDate() - dow); cursor.setUTCHours(0, 0, 0, 0); break; }
    case 'monthly': cursor.setUTCDate(1); cursor.setUTCHours(0, 0, 0, 0); break;
    default:        cursor.setUTCHours(0, 0, 0, 0);
  }
  while (cursor <= to) {
    const key = timeBucket(cursor, granularity);
    result.push({ date: cursor.toISOString(), count: map.get(key) || 0 });
    switch (granularity) {
      case 'hourly':  cursor.setUTCHours(cursor.getUTCHours() + 1);   break;
      case 'weekly':  cursor.setUTCDate(cursor.getUTCDate() + 7);      break;
      case 'monthly': cursor.setUTCMonth(cursor.getUTCMonth() + 1);    break;
      default:        cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  }
  return result;
}

function sortMap(map, limit = 50) {
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

// ── Session computation ───────────────────────────────────────────────────────
function computeSessions(entries) {
  const SESSION_GAP = 30 * 60 * 1000;
  const byIp = new Map();
  for (const e of entries) {
    const key = e.ip_hash || e.ip || 'unknown';
    if (!byIp.has(key)) byIp.set(key, []);
    byIp.get(key).push(new Date(e.ts || e.time).getTime());
  }
  let totalSessions = 0, bouncedSessions = 0, totalEngagedMs = 0;
  for (const times of byIp.values()) {
    times.sort((a, b) => a - b);
    let sessStart = times[0], sessLast = times[0], pagesInSess = 1;
    for (let i = 1; i < times.length; i++) {
      if (times[i] - sessLast > SESSION_GAP) {
        totalSessions++;
        if (pagesInSess === 1) bouncedSessions++;
        else totalEngagedMs += sessLast - sessStart;
        sessStart = times[i]; sessLast = times[i]; pagesInSess = 1;
      } else { sessLast = times[i]; pagesInSess++; }
    }
    totalSessions++;
    if (pagesInSess === 1) bouncedSessions++;
    else totalEngagedMs += sessLast - sessStart;
  }
  const engagedSessions = totalSessions - bouncedSessions;
  return {
    totalSessions,
    bounceRate:     totalSessions > 0 ? Math.round((bouncedSessions / totalSessions) * 100) : 0,
    avgDurationSec: engagedSessions > 0 ? Math.round(totalEngagedMs / 1000 / engagedSessions) : 0,
  };
}

// ── Build traffic_type WHERE clause ──────────────────────────────────────────
function trafficTypeClause(trafficType) {
  if (trafficType === 'bot')     return `traffic_type = 'bot'`;
  if (trafficType === 'crawler') return `traffic_type = 'crawler'`;
  if (trafficType === 'bots')    return `traffic_type IN ('bot','crawler')`;
  if (trafficType === 'real')    return `traffic_type = 'real'`;
  return `1=1`; // 'all'
}

// ── Check if DB has data for the requested domain/range ───────────────────────
async function dbHasData(domain, from, to) {
  try {
    const domainClause = domain && domain !== 'all' ? 'AND domain = ?' : '';
    const params = domain && domain !== 'all'
      ? [from, to, domain]
      : [from, to];
    const [rows] = await pool.query(
      `SELECT 1 FROM analytics_pageviews WHERE ts BETWEEN ? AND ? ${domainClause} LIMIT 1`,
      params
    );
    return rows.length > 0;
  } catch { return false; }
}

// ── DB-backed getStats ────────────────────────────────────────────────────────
async function getStatsFromDB(domain, from, to, granularity, trafficType) {
  const domainFilter = domain && domain !== 'all' ? 'AND domain = ?' : '';
  const ttFilter     = trafficTypeClause(trafficType);
  const baseParams   = domain && domain !== 'all' ? [from, to, domain] : [from, to];

  // Fetch all rows in range (for session computation + aggregations)
  // We fetch only the columns we need for efficiency
  const [rows] = await pool.query(
    `SELECT ts, ip_hash, url, referrer, ua, traffic_type, country, region, city
     FROM analytics_pageviews
     WHERE ts BETWEEN ? AND ? ${domainFilter}
       AND ${ttFilter}
     ORDER BY ts ASC`,
    baseParams
  );

  // Aggregation maps
  const ipSet        = new Set();
  const timeMap      = new Map();
  const pageMap      = new Map();
  const sourceMap    = new Map();
  const refDomainMap = new Map();
  const deviceMap    = new Map();
  const browserMap   = new Map();
  const osMap        = new Map();

  for (const r of rows) {
    ipSet.add(r.ip_hash);

    const bucket = timeBucket(r.ts, granularity);
    timeMap.set(bucket, (timeMap.get(bucket) || 0) + 1);

    pageMap.set(r.url, (pageMap.get(r.url) || 0) + 1);

    const { source, refDomain } = classifySource(r.referrer);
    sourceMap.set(source, (sourceMap.get(source) || 0) + 1);
    if (refDomain) refDomainMap.set(refDomain, (refDomainMap.get(refDomain) || 0) + 1);

    if (r.ua) {
      const { device, browser, os } = parseUA(r.ua);
      if (device !== 'Bot') {
        deviceMap.set(device,   (deviceMap.get(device)   || 0) + 1);
        browserMap.set(browser, (browserMap.get(browser) || 0) + 1);
        osMap.set(os,           (osMap.get(os)           || 0) + 1);
      }
    }
  }

  const { totalSessions, bounceRate, avgDurationSec } = computeSessions(rows);

  return {
    summary: {
      pageviews:      rows.length,
      uniqueVisitors: ipSet.size,
      sessions:       totalSessions,
      bounceRate,
      avgDurationSec,
    },
    timeSeries:       fillTimeGaps(timeMap, from, to, granularity),
    topPages:         sortMap(pageMap, 20),
    sources:          sortMap(sourceMap),
    referrers:        sortMap(refDomainMap, 15),
    devices:          sortMap(deviceMap),
    browsers:         sortMap(browserMap, 8),
    operatingSystems: sortMap(osMap),
    fromDB: true,
  };
}

// ── Log-file fallback getStats (no bot/geo, used before DB is populated) ──────
async function getStatsFromLogs(domain, from, to, granularity) {
  const logFiles = getLogFiles(domain);

  function readLogFile(filePath) {
    return new Promise((resolve) => {
      if (!fs.existsSync(filePath)) return resolve([]);
      const entries = [];
      const rl = readline.createInterface({
        input: fs.createReadStream(filePath, { encoding: 'utf8' }),
        crlfDelay: Infinity,
      });
      rl.on('line', (line) => {
        const e = parseLine(line);
        if (!e) return;
        if (e.time < from || e.time > to) return;
        if (e.method !== 'GET' && e.method !== 'HEAD') return;
        if (e.status >= 400) return;
        if (STATIC_RE.test(e.url)) return;
        if (INTERNAL_PATH_RE.test(e.url)) return;
        entries.push(e);
      });
      rl.on('close', () => resolve(entries));
      rl.on('error', () => resolve(entries));
    });
  }

  const fileResults = await Promise.all(logFiles.map(f => readLogFile(f)));
  let allEntries = fileResults.flat();
  allEntries.sort((a, b) => a.time - b.time);

  const ipSet = new Set();
  const timeMap = new Map(), pageMap = new Map(), sourceMap = new Map();
  const refDomainMap = new Map(), deviceMap = new Map(), browserMap = new Map(), osMap = new Map();

  for (const e of allEntries) {
    ipSet.add(e.ip);
    const bucket = timeBucket(e.time, granularity);
    timeMap.set(bucket, (timeMap.get(bucket) || 0) + 1);
    pageMap.set(e.url, (pageMap.get(e.url) || 0) + 1);
    const { source, refDomain } = classifySource(e.referer);
    sourceMap.set(source, (sourceMap.get(source) || 0) + 1);
    if (refDomain) refDomainMap.set(refDomain, (refDomainMap.get(refDomain) || 0) + 1);
    const { device, browser, os } = parseUA(e.ua);
    if (device !== 'Bot') {
      deviceMap.set(device, (deviceMap.get(device) || 0) + 1);
      browserMap.set(browser, (browserMap.get(browser) || 0) + 1);
      osMap.set(os, (osMap.get(os) || 0) + 1);
    }
  }

  // Adapt entries for computeSessions (expects ip_hash or ip field)
  const sessEntries = allEntries.map(e => ({ ip_hash: e.ip, ts: e.time }));
  const { totalSessions, bounceRate, avgDurationSec } = computeSessions(sessEntries);

  return {
    summary: {
      pageviews:      allEntries.length,
      uniqueVisitors: ipSet.size,
      sessions:       totalSessions,
      bounceRate,
      avgDurationSec,
    },
    timeSeries:       fillTimeGaps(timeMap, from, to, granularity),
    topPages:         sortMap(pageMap, 20),
    sources:          sortMap(sourceMap),
    referrers:        sortMap(refDomainMap, 15),
    devices:          sortMap(deviceMap),
    browsers:         sortMap(browserMap, 8),
    operatingSystems: sortMap(osMap),
    fromDB: false,
  };
}

// ── Public: getStats (DB-first, log fallback) ─────────────────────────────────
async function getStats(domain, from, to, granularity, trafficType = 'real') {
  granularity = granularity || 'daily';
  try {
    const hasData = await dbHasData(domain, from, to);
    if (hasData) {
      return await getStatsFromDB(domain, from, to, granularity, trafficType);
    }
  } catch (err) {
    console.error('[analytics] DB query failed, falling back to logs:', err.message);
  }
  // Fall back to live log reading
  return await getStatsFromLogs(domain, from, to, granularity);
}

// ── Public: getGeoStats — geographic breakdown from DB ────────────────────────
async function getGeoStats(domain, from, to, trafficType = 'real') {
  try {
    const domainFilter = domain && domain !== 'all' ? 'AND domain = ?' : '';
    const ttFilter     = trafficTypeClause(trafficType);
    const params       = domain && domain !== 'all' ? [from, to, domain] : [from, to];

    // Country breakdown
    const [countryRows] = await pool.query(
      `SELECT country, COUNT(*) AS cnt
       FROM analytics_pageviews
       WHERE ts BETWEEN ? AND ? ${domainFilter}
         AND ${ttFilter}
         AND country IS NOT NULL
       GROUP BY country
       ORDER BY cnt DESC
       LIMIT 50`,
      params
    );

    // Region breakdown
    const [regionRows] = await pool.query(
      `SELECT country, region, COUNT(*) AS cnt
       FROM analytics_pageviews
       WHERE ts BETWEEN ? AND ? ${domainFilter}
         AND ${ttFilter}
         AND country IS NOT NULL AND region IS NOT NULL
       GROUP BY country, region
       ORDER BY cnt DESC
       LIMIT 50`,
      params
    );

    // City breakdown
    const [cityRows] = await pool.query(
      `SELECT country, region, city, COUNT(*) AS cnt
       FROM analytics_pageviews
       WHERE ts BETWEEN ? AND ? ${domainFilter}
         AND ${ttFilter}
         AND city IS NOT NULL
       GROUP BY country, region, city
       ORDER BY cnt DESC
       LIMIT 50`,
      params
    );

    return {
      countries: countryRows.map(r => ({ code: r.country, count: Number(r.cnt) })),
      regions:   regionRows.map(r => ({ country: r.country, region: r.region, count: Number(r.cnt) })),
      cities:    cityRows.map(r => ({ country: r.country, region: r.region, city: r.city, count: Number(r.cnt) })),
    };
  } catch (err) {
    console.error('[analytics] getGeoStats error:', err.message);
    return { countries: [], regions: [], cities: [] };
  }
}

// ── Public: getRealtime — distinct visitors in last 5 minutes ────────────────
async function getRealtime(domain) {
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
  const now        = new Date();

  try {
    // Try DB first
    const hasData = await dbHasData(domain, fiveMinAgo, now);
    if (hasData) {
      const domainFilter = domain && domain !== 'all' ? 'AND domain = ?' : '';
      const params       = domain && domain !== 'all'
        ? [fiveMinAgo, now, domain]
        : [fiveMinAgo, now];
      const [rows] = await pool.query(
        `SELECT COUNT(DISTINCT ip_hash) AS cnt
         FROM analytics_pageviews
         WHERE ts BETWEEN ? AND ? ${domainFilter}
           AND traffic_type = 'real'`,
        params
      );
      return { activeVisitors: Number(rows[0]?.cnt || 0) };
    }
  } catch (_) { /* fall through */ }

  // Fallback: read log files
  const logFiles   = getLogFiles(domain);
  function readLogFile(filePath) {
    return new Promise((resolve) => {
      if (!fs.existsSync(filePath)) return resolve([]);
      const ipSet = new Set();
      const rl = readline.createInterface({ input: fs.createReadStream(filePath, { encoding: 'utf8' }), crlfDelay: Infinity });
      rl.on('line', (line) => {
        const e = parseLine(line);
        if (!e || e.time < fiveMinAgo || e.time > now) return;
        if (STATIC_RE.test(e.url) || INTERNAL_PATH_RE.test(e.url)) return;
        ipSet.add(e.ip);
      });
      rl.on('close', () => resolve([...ipSet]));
      rl.on('error', () => resolve([]));
    });
  }
  const results = await Promise.all(logFiles.map(readLogFile));
  const ipSet   = new Set(results.flat());
  return { activeVisitors: ipSet.size };
}

module.exports = { listLogDomains, getStats, getGeoStats, getRealtime };
