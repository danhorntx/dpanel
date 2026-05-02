'use strict';
/**
 * lib/analytics.js — DAnalytics query layer
 *
 * ── Public API ─────────────────────────────────────────────────────────────────
 *
 *   listLogDomains() → string[]
 *
 *   getStats(domain, from, to, granularity, trafficType, tz) → StatsResult
 *   getComparisonStats(domain, from, to, granularity, trafficType, tz) → { current, previous }
 *   getGeoStats(domain, from, to, trafficType) → GeoResult
 *   getErrorStats(domain, from, to) → ErrorResult
 *   getRealtime(domain) → { activeVisitors }
 *   getHealthStatus() → { lastRun, domains }
 */

const fs       = require('fs');
const path     = require('path');
const readline = require('readline');
const { pool } = require('./db');

const LOG_DIR = '/var/log/apache2';

// ── Shared helpers ─────────────────────────────────────────────────────────────

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

// ── Domain listing ─────────────────────────────────────────────────────────────
function listLogDomains() {
  if (!fs.existsSync(LOG_DIR)) return [];
  return fs.readdirSync(LOG_DIR)
    .filter(f => f.endsWith('_access.log') || f.endsWith('-access.log'))
    .filter(f => !f.includes('-le-ssl') && !f.includes('000-default') && !f.startsWith('other_'))
    .filter(f => f !== 'panel_access.log' && f !== 'panel-access.log')
    .map(f => f.replace(/_access\.log$/, '').replace(/-access\.log$/, ''))
    .sort();
}

// ── Timezone helpers ──────────────────────────────────────────────────────────

/**
 * Returns the offset in milliseconds: local_time_ms - utc_time_ms
 * For UTC-5 (CDT) this returns -18000000 (= -5h in ms)
 */
function getTimezoneOffsetMs(date, tz) {
  if (!tz || tz === 'UTC') return 0;
  try {
    const f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    });
    const parts = f.formatToParts(date).reduce((a, p) => { a[p.type] = p.value; return a; }, {});
    const h = parts.hour === '24' ? 0 : +parts.hour;
    const localMs = Date.UTC(+parts.year, +parts.month - 1, +parts.day, h, +parts.minute, +parts.second);
    return localMs - date.getTime();
  } catch { return 0; }
}

/**
 * Convert a UTC date to "local midnight UTC" for the given timezone.
 * i.e.: what UTC timestamp is midnight of the local day this date falls in?
 */
function toLocalMidnightUTC(date, tz) {
  if (!tz || tz === 'UTC') {
    const d = new Date(date); d.setUTCHours(0, 0, 0, 0); return d;
  }
  const offset = getTimezoneOffsetMs(date, tz);
  const localMs = date.getTime() + offset;
  const localMidnight = new Date(localMs);
  localMidnight.setUTCHours(0, 0, 0, 0);
  // Convert back to UTC
  return new Date(localMidnight.getTime() - offset);
}

/**
 * Parse a YYYY-MM-DD string as the local midnight UTC for the given timezone.
 */
function parseLocalDate(dateStr, tz) {
  // Parse as UTC midnight
  const utcMidnight = new Date(dateStr + 'T00:00:00.000Z');
  if (!tz || tz === 'UTC') return utcMidnight;
  // Find local midnight: UTC_midnight - offset = local_midnight_in_UTC
  // (local_time = UTC + offset, so midnight_local_as_UTC = midnight_local - offset)
  const offset = getTimezoneOffsetMs(utcMidnight, tz);
  return new Date(utcMidnight.getTime() - offset);
}

/**
 * Parse a YYYY-MM-DD string as end-of-local-day UTC for the given timezone.
 */
function parseLocalEndOfDay(dateStr, tz) {
  const start = parseLocalDate(dateStr, tz);
  return new Date(start.getTime() + 86400000 - 1); // +24h - 1ms
}

// ── Time bucketing helpers ────────────────────────────────────────────────────

/**
 * Bucket a UTC timestamp into a local-time-aware ISO string bucket key.
 * The returned ISO string represents the START of the bucket in "local-shifted UTC"
 * (i.e., it looks like a UTC timestamp but actually encodes local time boundaries).
 */
function timeBucket(date, granularity, tz = 'UTC') {
  const d = new Date(date);
  const offset = getTimezoneOffsetMs(d, tz);
  // Shift to local time space
  const local = new Date(d.getTime() + offset);

  switch (granularity) {
    case 'hourly':
      local.setUTCMinutes(0, 0, 0);
      break;
    case 'weekly': {
      const dow = local.getUTCDay();
      local.setUTCDate(local.getUTCDate() - dow);
      local.setUTCHours(0, 0, 0, 0);
      break;
    }
    case 'monthly':
      local.setUTCDate(1);
      local.setUTCHours(0, 0, 0, 0);
      break;
    default: // daily
      local.setUTCHours(0, 0, 0, 0);
  }
  return local.toISOString();
}

/**
 * Fill in zero-count buckets between from and to (both UTC).
 * Returns array of { date: ISOString, count } where date is in local-shifted UTC space.
 */
function fillTimeGaps(map, from, to, granularity, tz = 'UTC') {
  const result = [];
  const offset = getTimezoneOffsetMs(from, tz);

  // Work in "local time space" (shifted)
  const localFrom = new Date(from.getTime() + offset);
  const localTo   = new Date(to.getTime() + offset);

  const cursor = new Date(localFrom);
  switch (granularity) {
    case 'hourly':  cursor.setUTCMinutes(0, 0, 0); break;
    case 'weekly':  { const dow = cursor.getUTCDay(); cursor.setUTCDate(cursor.getUTCDate() - dow); cursor.setUTCHours(0, 0, 0, 0); break; }
    case 'monthly': cursor.setUTCDate(1); cursor.setUTCHours(0, 0, 0, 0); break;
    default:        cursor.setUTCHours(0, 0, 0, 0);
  }

  while (cursor <= localTo) {
    const key = cursor.toISOString();
    result.push({ date: key, count: map.get(key) || 0 });
    switch (granularity) {
      case 'hourly':  cursor.setUTCHours(cursor.getUTCHours() + 1); break;
      case 'weekly':  cursor.setUTCDate(cursor.getUTCDate() + 7); break;
      case 'monthly': cursor.setUTCMonth(cursor.getUTCMonth() + 1); break;
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
    const key = e.visitor_fingerprint || e.ip_hash || e.ip || 'unknown';
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

// ── Traffic type WHERE clause ─────────────────────────────────────────────────
function trafficTypeClause(trafficType) {
  if (trafficType === 'bot')     return `traffic_type = 'bot'`;
  if (trafficType === 'crawler') return `traffic_type = 'crawler'`;
  if (trafficType === 'bots')    return `traffic_type IN ('bot','crawler','suspicious')`;
  if (trafficType === 'real')    return `traffic_type = 'real'`;
  return `1=1`;
}

// ── Check if DB has data ──────────────────────────────────────────────────────
async function dbHasData(domain, from, to) {
  try {
    const domainClause = domain && domain !== 'all' ? 'AND domain = ?' : '';
    const params = domain && domain !== 'all' ? [from, to, domain] : [from, to];
    const [rows] = await pool.query(
      `SELECT 1 FROM analytics_pageviews WHERE ts BETWEEN ? AND ? ${domainClause} LIMIT 1`,
      params
    );
    return rows.length > 0;
  } catch { return false; }
}

// ── DB-backed getStats ────────────────────────────────────────────────────────
async function getStatsFromDB(domain, from, to, granularity, trafficType, tz = 'UTC') {
  const domainFilter = domain && domain !== 'all' ? 'AND domain = ?' : '';
  const ttFilter     = trafficTypeClause(trafficType);
  const baseParams   = domain && domain !== 'all' ? [from, to, domain] : [from, to];

  const [rows] = await pool.query(
    `SELECT ts, visitor_fingerprint, ip_hash, url, referrer, ua, traffic_type, country, region, city
     FROM analytics_pageviews
     WHERE ts BETWEEN ? AND ? ${domainFilter}
       AND ${ttFilter}
     ORDER BY ts ASC`,
    baseParams
  );

  const visitorSet   = new Set();
  const timeMap      = new Map();
  const pageMap      = new Map();
  const sourceMap    = new Map();
  const refDomainMap = new Map();
  const deviceMap    = new Map();
  const browserMap   = new Map();
  const osMap        = new Map();

  for (const r of rows) {
    // Prefer visitor_fingerprint for unique visitor counting (more accurate than ip_hash alone)
    visitorSet.add(r.visitor_fingerprint || r.ip_hash);

    const bucket = timeBucket(r.ts, granularity, tz);
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
      uniqueVisitors: visitorSet.size,
      sessions:       totalSessions,
      bounceRate,
      avgDurationSec,
    },
    timeSeries:       fillTimeGaps(timeMap, from, to, granularity, tz),
    topPages:         sortMap(pageMap, 20),
    sources:          sortMap(sourceMap),
    referrers:        sortMap(refDomainMap, 15),
    devices:          sortMap(deviceMap),
    browsers:         sortMap(browserMap, 8),
    operatingSystems: sortMap(osMap),
    tz,
    fromDB: true,
  };
}

// ── Rollup-backed getStats (for ranges > 7 days, daily granularity) ───────────
async function getStatsFromRollup(domain, from, to, tz = 'UTC') {
  try {
    const domainFilter = domain && domain !== 'all' ? 'AND domain = ?' : '';
    const params = domain && domain !== 'all' ? [from, to, domain] : [from, to];

    const [rows] = await pool.query(
      `SELECT date, pageviews, visitors, sessions, bounce_rate, avg_duration, bot_requests
       FROM analytics_daily_summary
       WHERE date BETWEEN DATE(?) AND DATE(?) ${domainFilter}
       ORDER BY date ASC`,
      params
    );

    if (!rows.length) return null; // rollup not populated yet

    const timeMap    = new Map();
    let totalPV      = 0, totalVis = 0, totalSess = 0;
    let totalBR      = 0, totalDur = 0, brCount = 0, durCount = 0;

    for (const r of rows) {
      // Convert UTC date to local bucket key
      const utcDate = new Date(r.date + 'T12:00:00Z');
      const bucket  = timeBucket(utcDate, 'daily', tz);
      timeMap.set(bucket, (timeMap.get(bucket) || 0) + r.pageviews);
      totalPV  += r.pageviews;
      totalVis += r.visitors;
      totalSess += r.sessions;
      if (r.bounce_rate > 0) { totalBR += r.bounce_rate; brCount++; }
      if (r.avg_duration > 0) { totalDur += r.avg_duration; durCount++; }
    }

    return {
      summary: {
        pageviews:      totalPV,
        uniqueVisitors: totalVis,
        sessions:       totalSess,
        bounceRate:     brCount > 0 ? Math.round(totalBR / brCount) : 0,
        avgDurationSec: durCount > 0 ? Math.round(totalDur / durCount) : 0,
      },
      timeSeries: fillTimeGaps(timeMap, from, to, 'daily', tz),
      fromRollup: true,
      tz,
    };
  } catch { return null; }
}

// ── Log-file fallback getStats ────────────────────────────────────────────────
async function getStatsFromLogs(domain, from, to, granularity, tz = 'UTC') {
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
    const bucket = timeBucket(e.time, granularity, tz);
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
    timeSeries:       fillTimeGaps(timeMap, from, to, granularity, tz),
    topPages:         sortMap(pageMap, 20),
    sources:          sortMap(sourceMap),
    referrers:        sortMap(refDomainMap, 15),
    devices:          sortMap(deviceMap),
    browsers:         sortMap(browserMap, 8),
    operatingSystems: sortMap(osMap),
    tz,
    fromDB: false,
  };
}

// ── Public: getStats (DB-first; rollup for large ranges; log fallback) ─────────
async function getStats(domain, from, to, granularity, trafficType = 'real', tz = 'UTC') {
  granularity = granularity || 'daily';
  try {
    const rangeMs = to - from;
    const days    = rangeMs / 86400000;

    // For ranges > 7 days with daily granularity and 'real' traffic, try rollup first
    if (days > 7 && granularity === 'daily' && trafficType === 'real') {
      const rollupData = await getStatsFromRollup(domain, from, to, tz);
      if (rollupData) {
        // Rollup is partial (only covers summary + timeseries)
        // Merge with limited DB queries for breakdown data
        const hasData = await dbHasData(domain, from, to);
        if (hasData) {
          try {
            const breakdown = await getBreakdownFromDB(domain, from, to, trafficType);
            return { ...rollupData, ...breakdown, fromRollup: true };
          } catch { /* fall through to full DB query */ }
        }
        return rollupData;
      }
    }

    const hasData = await dbHasData(domain, from, to);
    if (hasData) {
      return await getStatsFromDB(domain, from, to, granularity, trafficType, tz);
    }
  } catch (err) {
    console.error('[analytics] DB query failed, falling back to logs:', err.message);
  }
  return await getStatsFromLogs(domain, from, to, granularity, tz);
}

// ── Breakdown-only query (pages, sources, devices) ────────────────────────────
async function getBreakdownFromDB(domain, from, to, trafficType) {
  const domainFilter = domain && domain !== 'all' ? 'AND domain = ?' : '';
  const ttFilter     = trafficTypeClause(trafficType);
  const baseParams   = domain && domain !== 'all' ? [from, to, domain] : [from, to];

  const [rows] = await pool.query(
    `SELECT url, referrer, ua
     FROM analytics_pageviews
     WHERE ts BETWEEN ? AND ? ${domainFilter} AND ${ttFilter}`,
    baseParams
  );

  const pageMap = new Map(), sourceMap = new Map(), refDomainMap = new Map();
  const deviceMap = new Map(), browserMap = new Map(), osMap = new Map();

  for (const r of rows) {
    pageMap.set(r.url, (pageMap.get(r.url) || 0) + 1);
    const { source, refDomain } = classifySource(r.referrer);
    sourceMap.set(source, (sourceMap.get(source) || 0) + 1);
    if (refDomain) refDomainMap.set(refDomain, (refDomainMap.get(refDomain) || 0) + 1);
    if (r.ua) {
      const { device, browser, os } = parseUA(r.ua);
      if (device !== 'Bot') {
        deviceMap.set(device, (deviceMap.get(device) || 0) + 1);
        browserMap.set(browser, (browserMap.get(browser) || 0) + 1);
        osMap.set(os, (osMap.get(os) || 0) + 1);
      }
    }
  }
  return {
    topPages:         sortMap(pageMap, 20),
    sources:          sortMap(sourceMap),
    referrers:        sortMap(refDomainMap, 15),
    devices:          sortMap(deviceMap),
    browsers:         sortMap(browserMap, 8),
    operatingSystems: sortMap(osMap),
  };
}

// ── Public: getComparisonStats — current period vs previous period ─────────────
async function getComparisonStats(domain, from, to, granularity, trafficType, tz) {
  const rangeMs = to - from;
  const prevFrom = new Date(from.getTime() - rangeMs);
  const prevTo   = new Date(from.getTime() - 1);

  const [current, previous] = await Promise.all([
    getStats(domain, from, to, granularity, trafficType, tz),
    getStats(domain, prevFrom, prevTo, granularity, trafficType, tz),
  ]);

  return { current, previous };
}

// ── Public: getGeoStats ───────────────────────────────────────────────────────
async function getGeoStats(domain, from, to, trafficType = 'real') {
  try {
    const domainFilter = domain && domain !== 'all' ? 'AND domain = ?' : '';
    const ttFilter     = trafficTypeClause(trafficType);
    const params       = domain && domain !== 'all' ? [from, to, domain] : [from, to];

    const [countryRows] = await pool.query(
      `SELECT country, COUNT(*) AS cnt FROM analytics_pageviews
       WHERE ts BETWEEN ? AND ? ${domainFilter} AND ${ttFilter} AND country IS NOT NULL
       GROUP BY country ORDER BY cnt DESC LIMIT 50`,
      params
    );
    const [regionRows] = await pool.query(
      `SELECT country, region, COUNT(*) AS cnt FROM analytics_pageviews
       WHERE ts BETWEEN ? AND ? ${domainFilter} AND ${ttFilter} AND country IS NOT NULL AND region IS NOT NULL
       GROUP BY country, region ORDER BY cnt DESC LIMIT 50`,
      params
    );
    const [cityRows] = await pool.query(
      `SELECT country, region, city, COUNT(*) AS cnt FROM analytics_pageviews
       WHERE ts BETWEEN ? AND ? ${domainFilter} AND ${ttFilter} AND city IS NOT NULL
       GROUP BY country, region, city ORDER BY cnt DESC LIMIT 50`,
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

// ── Public: getErrorStats — HTTP 4xx/5xx breakdown ───────────────────────────
async function getErrorStats(domain, from, to) {
  try {
    const domainFilter = domain && domain !== 'all' ? 'AND domain = ?' : '';
    const params       = domain && domain !== 'all' ? [from, to, domain] : [from, to];

    // Status code breakdown
    const [statusRows] = await pool.query(
      `SELECT status, COUNT(*) AS cnt FROM analytics_pageviews
       WHERE ts BETWEEN ? AND ? ${domainFilter}
         AND status >= 400
       GROUP BY status ORDER BY cnt DESC LIMIT 20`,
      params
    );

    // Top error URLs
    const [urlRows] = await pool.query(
      `SELECT url, status, COUNT(*) AS cnt FROM analytics_pageviews
       WHERE ts BETWEEN ? AND ? ${domainFilter}
         AND status >= 400
       GROUP BY url, status ORDER BY cnt DESC LIMIT 20`,
      params
    );

    // Total requests (for error rate calc)
    const [totalRow] = await pool.query(
      `SELECT COUNT(*) AS cnt FROM analytics_pageviews WHERE ts BETWEEN ? AND ? ${domainFilter}`,
      params
    );

    const totalRequests = Number(totalRow[0]?.cnt || 0);
    const errorRequests = statusRows.reduce((s, r) => s + Number(r.cnt), 0);

    return {
      statusBreakdown: statusRows.map(r => ({ status: r.status, count: Number(r.cnt) })),
      topErrorUrls:    urlRows.map(r => ({ url: r.url, status: r.status, count: Number(r.cnt) })),
      errorRate:       totalRequests > 0 ? Math.round((errorRequests / totalRequests) * 1000) / 10 : 0,
      errorRequests,
      totalRequests,
    };
  } catch (err) {
    console.error('[analytics] getErrorStats error:', err.message);
    return { statusBreakdown: [], topErrorUrls: [], errorRate: 0, errorRequests: 0, totalRequests: 0 };
  }
}

// ── Public: getPageDrilldown — hourly breakdown for a single page ─────────────
async function getPageDrilldown(domain, url, from, to, tz = 'UTC') {
  try {
    const domainFilter = domain && domain !== 'all' ? 'AND domain = ?' : '';
    const params = domain && domain !== 'all' ? [from, to, url, domain] : [from, to, url];

    const [rows] = await pool.query(
      `SELECT ts, ip_hash, visitor_fingerprint, referrer FROM analytics_pageviews
       WHERE ts BETWEEN ? AND ? AND url = ? ${domainFilter}
         AND traffic_type = 'real'
       ORDER BY ts ASC`,
      params
    );

    const timeMap   = new Map();
    const refMap    = new Map();
    const visitorSet = new Set();

    for (const r of rows) {
      visitorSet.add(r.visitor_fingerprint || r.ip_hash);
      const bucket = timeBucket(r.ts, 'hourly', tz);
      timeMap.set(bucket, (timeMap.get(bucket) || 0) + 1);
      const { refDomain } = classifySource(r.referrer);
      if (refDomain) refMap.set(refDomain, (refMap.get(refDomain) || 0) + 1);
    }

    return {
      url,
      totalPageviews: rows.length,
      uniqueVisitors: visitorSet.size,
      timeSeries:     fillTimeGaps(timeMap, from, to, 'hourly', tz),
      topReferrers:   sortMap(refMap, 10),
    };
  } catch (err) {
    console.error('[analytics] getPageDrilldown error:', err.message);
    return null;
  }
}

// ── Public: getRealtime ───────────────────────────────────────────────────────
async function getRealtime(domain) {
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
  const now        = new Date();

  try {
    const hasData = await dbHasData(domain, fiveMinAgo, now);
    if (hasData) {
      const domainFilter = domain && domain !== 'all' ? 'AND domain = ?' : '';
      const params       = domain && domain !== 'all' ? [fiveMinAgo, now, domain] : [fiveMinAgo, now];
      const [rows] = await pool.query(
        `SELECT COUNT(DISTINCT COALESCE(visitor_fingerprint, ip_hash)) AS cnt
         FROM analytics_pageviews
         WHERE ts BETWEEN ? AND ? ${domainFilter} AND traffic_type = 'real'`,
        params
      );
      return { activeVisitors: Number(rows[0]?.cnt || 0) };
    }
  } catch (_) { /* fall through */ }

  const logFiles = getLogFiles(domain);
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

// ── Public: getHealthStatus — ingestion health summary ────────────────────────
async function getHealthStatus() {
  try {
    const [rows] = await pool.query(
      `SELECT domain, MAX(run_at) AS last_run,
              SUM(rows_inserted) AS total_inserted,
              SUM(rows_skipped) AS total_skipped,
              MAX(IF(error_msg IS NOT NULL, run_at, NULL)) AS last_error_at
       FROM analytics_ingest_health
       WHERE run_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)
       GROUP BY domain
       ORDER BY last_run DESC`
    );
    const [cursor] = await pool.query(
      `SELECT MAX(updated_at) AS last_update FROM analytics_log_cursors`
    );
    return {
      lastCursorUpdate: cursor[0]?.last_update || null,
      domains: rows.map(r => ({
        domain:        r.domain,
        lastRun:       r.last_run,
        totalInserted: Number(r.total_inserted || 0),
        totalSkipped:  Number(r.total_skipped || 0),
        lastErrorAt:   r.last_error_at || null,
      })),
    };
  } catch (err) {
    return { lastCursorUpdate: null, domains: [], error: err.message };
  }
}

// ── Export helpers (used by routes) ──────────────────────────────────────────
function parseLocalDateExport(dateStr, tz) { return parseLocalDate(dateStr, tz); }
function parseLocalEndOfDayExport(dateStr, tz) { return parseLocalEndOfDay(dateStr, tz); }

module.exports = {
  listLogDomains,
  getStats,
  getComparisonStats,
  getGeoStats,
  getErrorStats,
  getPageDrilldown,
  getRealtime,
  getHealthStatus,
  parseLocalDate: parseLocalDateExport,
  parseLocalEndOfDay: parseLocalEndOfDayExport,
};
