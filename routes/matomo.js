'use strict';
/**
 * routes/matomo.js — DPanel ↔ Matomo bridge.
 *
 *   GET    /api/matomo/status              — is the matomo stack reachable?
 *   GET    /api/matomo/domains/:domain     — return { matomoSiteId, snippet }
 *   POST   /api/matomo/domains/:domain     — provision a matomo site for this
 *                                            domain if not already mapped;
 *                                            returns { matomoSiteId, snippet }.
 *                                            Body: { ecommerce?: bool }
 *   DELETE /api/matomo/domains/:domain     — remove the matomo site + mapping
 *                                            (irreversible — purges analytics
 *                                            data for that site).
 *
 * Implementation: shells out to `docker exec matomo-app php matomo-cli.php`
 * which calls Matomo's PHP API via Access::doAsSuperUser(). We don't need an
 * HTTP token for this — same-host privilege.
 *
 * The snippet uses obfuscated paths (/cdn/script.js, /cdn/event.php) wired
 * up in the Apache vhost so ad-blockers can't trivially nuke the tracker.
 */

const express     = require('express');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { pool }    = require('../lib/db');
const { sanitizeDomain } = require('../lib/shell');

const router = express.Router();
const execFileP = promisify(execFile);

const MATOMO_HOST = 'analytics.danhorntx.com';
const CDN_JS      = '/cdn/script.js';
const CDN_PHP     = '/cdn/event.php';

// ── matomo-cli.php helper ─────────────────────────────────────────────────
// Runs the script inside the matomo-app container. Each call gets ~5s
// budget; container is local so this is plenty. Throws on non-zero exit.
async function matomo(...args) {
  // execFile resists argv injection from caller (no shell).
  const { stdout, stderr } = await execFileP(
    'docker',
    ['exec', 'matomo-app', 'php', '/var/www/html/matomo-cli.php', ...args],
    { timeout: 5000 }
  );
  if (stderr && !stdout) throw new Error(stderr.trim());
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`unexpected non-JSON from matomo-cli: ${stdout.slice(0, 200)}`);
  }
}

// ── Snippet builder ───────────────────────────────────────────────────────
// Always cookieless (PrivacyManager.forceCookielessTracking = 1 globally),
// honors DoNotTrack, uses the obfuscated paths from the Apache vhost.
function buildSnippet({ matomoSiteId }) {
  return `<!-- Matomo (Duperhuman analytics) -->
<script>
  var _paq = window._paq = window._paq || [];
  _paq.push(['disableCookies']);
  _paq.push(['setDoNotTrack', true]);
  _paq.push(['trackPageView']);
  _paq.push(['enableLinkTracking']);
  (function() {
    var u = "https://${MATOMO_HOST}/";
    _paq.push(['setTrackerUrl', u + '${CDN_PHP.replace(/^\//, '')}']);
    _paq.push(['setSiteId', '${matomoSiteId}']);
    var d = document, g = d.createElement('script'), s = d.getElementsByTagName('script')[0];
    g.async = true; g.src = u + '${CDN_JS.replace(/^\//, '')}'; s.parentNode.insertBefore(g, s);
  })();
</script>
<!-- End Matomo -->`;
}

// ── DB helpers ────────────────────────────────────────────────────────────
async function getMapping(domain) {
  const [rows] = await pool.query(
    'SELECT matomo_site_id FROM dpanel_domain_meta WHERE domain = ?',
    [domain]
  );
  return rows[0]?.matomo_site_id ?? null;
}

async function setMapping(domain, idsite) {
  await pool.query(
    `INSERT INTO dpanel_domain_meta (domain, matomo_site_id) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE matomo_site_id = VALUES(matomo_site_id)`,
    [domain, idsite]
  );
}

async function clearMapping(domain) {
  await pool.query(
    'UPDATE dpanel_domain_meta SET matomo_site_id = NULL WHERE domain = ?',
    [domain]
  );
}

// ── GET /status ───────────────────────────────────────────────────────────
router.get('/status', async (req, res) => {
  try {
    const sites = await matomo('list-sites');
    res.json({
      success: true,
      data: { reachable: true, host: MATOMO_HOST, siteCount: sites.length },
    });
  } catch (err) {
    res.json({ success: false, error: err.message, data: { reachable: false } });
  }
});

// ── GET /domains/:domain ──────────────────────────────────────────────────
router.get('/domains/:domain', async (req, res) => {
  try {
    sanitizeDomain(req.params.domain);
    const matomoSiteId = await getMapping(req.params.domain);
    if (!matomoSiteId) {
      return res.json({ success: true, data: { matomoSiteId: null, snippet: null } });
    }
    res.json({
      success: true,
      data: {
        matomoSiteId,
        snippet: buildSnippet({ matomoSiteId }),
        dashboardUrl: `https://${MATOMO_HOST}/index.php?module=CoreHome&action=index&idSite=${matomoSiteId}&period=day&date=yesterday`,
      },
    });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// ── POST /domains/:domain ─────────────────────────────────────────────────
router.post('/domains/:domain', async (req, res) => {
  try {
    sanitizeDomain(req.params.domain);
    const domain = req.params.domain;
    const ecommerce = req.body?.ecommerce ? 1 : 0;

    // Idempotent — if already mapped, return existing.
    const existing = await getMapping(domain);
    if (existing) {
      return res.json({
        success: true,
        data: { matomoSiteId: existing, snippet: buildSnippet({ matomoSiteId: existing }), alreadyExisted: true },
      });
    }

    // Provision new site in Matomo.
    const result = await matomo('add-site', domain, `https://${domain}`, String(ecommerce));
    if (!result?.idsite) throw new Error('matomo-cli add-site returned no idsite');

    await setMapping(domain, result.idsite);

    res.json({
      success: true,
      data: {
        matomoSiteId:  result.idsite,
        snippet:       buildSnippet({ matomoSiteId: result.idsite }),
        dashboardUrl:  `https://${MATOMO_HOST}/index.php?module=CoreHome&action=index&idSite=${result.idsite}&period=day&date=yesterday`,
        alreadyExisted: false,
      },
    });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// ── DELETE /domains/:domain ───────────────────────────────────────────────
router.delete('/domains/:domain', async (req, res) => {
  try {
    sanitizeDomain(req.params.domain);
    const domain = req.params.domain;
    const matomoSiteId = await getMapping(domain);
    if (!matomoSiteId) return res.json({ success: true, data: { removed: false, reason: 'no mapping' } });
    await matomo('delete-site', String(matomoSiteId));
    await clearMapping(domain);
    res.json({ success: true, data: { removed: true } });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

module.exports = router;
