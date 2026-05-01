'use strict';
/**
 * lib/botdetect.js — Bot / crawler detection
 *
 * Returns one of three traffic_type values:
 *   'real'    — human visitor
 *   'bot'     — generic bot / automated tool
 *   'crawler' — legitimate search-engine / social crawler
 *
 * Strategy (in priority order):
 *  1. Empty or missing UA → bot
 *  2. isbot npm package   → crawler or bot
 *  3. Custom allow-list   → crawler (known good bots)
 *  4. Custom block-list   → bot    (known bad patterns)
 *  5. Heuristics          → bot    (headless UA strings, etc.)
 */

let isbot;
try {
  const isbotPkg = require('isbot');
  // isbot v3: default export is the function
  // isbot v4+: named export `isbot`
  isbot = typeof isbotPkg === 'function' ? isbotPkg : (isbotPkg.isbot || null);
} catch (_) {
  isbot = null; // graceful degradation if package not installed yet
}

// ── Known legitimate crawlers (search engines, social media, monitors) ────────
const CRAWLER_RE = /(?:Googlebot|Google-InspectionTool|Googlebot-Image|Googlebot-Video|GoogleAdSenseInfeed|AdsBot-Google|bingbot|BingPreview|Slurp|DuckDuckBot|Baiduspider|YandexBot|facebot|facebookexternalhit|Twitterbot|LinkedInBot|Slackbot|WhatsApp|TelegramBot|Discordbot|Applebot|Pingdom|UptimeRobot|StatusCake|Better Uptime|DatadogAgent)/i;

// ── Known bad / scraper / spam bot patterns ───────────────────────────────────
const BAD_BOT_RE = /(?:zgrab|masscan|nmap|sqlmap|nikto|acunetix|nessus|openvas|w3af|dirbuster|gobuster|wfuzz|hydra|medusa|burpsuite|scrapy|python-requests|python-urllib|go-http-client|curl\/|libwww-perl|lwp-|wget\/|java\/|okhttp\/|ahrefsbot|semrushbot|dotbot|mj12bot|blexbot|petalbot|bytespider|gptbot|claudebot|ccbot|fbot|ia_archiver|archive\.org_bot|theknowledge|dataforseo|serpstatbot|seokicks|seoscanners|mailchimp)/i;

// ── Headless / automation UA patterns ────────────────────────────────────────
const HEADLESS_RE = /(?:HeadlessChrome|PhantomJS|Nightmare|Puppeteer|Playwright|Selenium|WebDriver|htmlunit|phantomjs)/i;

/**
 * classify(ua) → { type: 'real'|'bot'|'crawler', reason: string|null }
 *
 * @param {string|null|undefined} ua  The raw User-Agent string
 */
function classify(ua) {
  // 1. Missing / empty UA
  if (!ua || ua.trim() === '' || ua === '-') {
    return { type: 'bot', reason: 'empty-ua' };
  }

  // 2. Known legitimate crawler allow-list (before isbot — we want 'crawler' not 'bot')
  if (CRAWLER_RE.test(ua)) {
    return { type: 'crawler', reason: 'known-crawler' };
  }

  // 3. Known bad bot patterns
  if (BAD_BOT_RE.test(ua)) {
    return { type: 'bot', reason: 'bad-bot-pattern' };
  }

  // 4. Headless / automation
  if (HEADLESS_RE.test(ua)) {
    return { type: 'bot', reason: 'headless-browser' };
  }

  // 5. isbot package (broad community-maintained list)
  if (isbot && isbot(ua)) {
    return { type: 'bot', reason: 'isbot' };
  }

  // 6. Real human
  return { type: 'real', reason: null };
}

module.exports = { classify };
