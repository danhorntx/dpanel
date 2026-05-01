'use strict';
/**
 * routes/analytics.js — DAnalytics REST API
 * Mount at: /api/analytics  (requireLogin applied in server.js)
 */
const express   = require('express');
const analytics = require('../lib/analytics');
const router    = express.Router();

// ── GET /api/analytics/domains ────────────────────────────────────────────────
router.get('/domains', (req, res) => {
  try {
    res.json({ success: true, data: analytics.listLogDomains() });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ── GET /api/analytics/stats ──────────────────────────────────────────────────
// Query params:
//   domain       string   'all' or a specific domain name  (default: 'all')
//   from         ISO date start of range                   (default: 30 days ago)
//   to           ISO date end of range                     (default: now)
//   granularity  'hourly' | 'daily' | 'weekly' | 'monthly' (default: 'daily')
//   trafficType  'real' | 'bot' | 'crawler' | 'bots' | 'all'  (default: 'real')
router.get('/stats', async (req, res) => {
  try {
    const {
      domain      = 'all',
      from,
      to,
      granularity = 'daily',
      trafficType = 'real',
    } = req.query;

    const fromDate = from ? new Date(from) : new Date(Date.now() - 30 * 86400000);
    // If `to` is a bare date string (YYYY-MM-DD), extend to end-of-day so the
    // full day is included in the BETWEEN range.  A bare date parses as UTC
    // midnight, giving a zero-second window when from === to (e.g. "Today").
    const toDate = to
      ? (to.length === 10 ? new Date(to + 'T23:59:59.999Z') : new Date(to))
      : new Date();

    if (isNaN(fromDate) || isNaN(toDate)) {
      return res.json({ success: false, error: 'Invalid date range' });
    }

    const data = await analytics.getStats(domain, fromDate, toDate, granularity, trafficType);
    res.json({ success: true, data });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ── GET /api/analytics/geo ────────────────────────────────────────────────────
// Query params: same domain, from, to, trafficType as /stats
// Returns: { countries: [{code, count}], regions: [{country, region, count}], cities: [...] }
router.get('/geo', async (req, res) => {
  try {
    const {
      domain      = 'all',
      from,
      to,
      trafficType = 'real',
    } = req.query;

    const fromDate = from ? new Date(from) : new Date(Date.now() - 30 * 86400000);
    const toDate = to
      ? (to.length === 10 ? new Date(to + 'T23:59:59.999Z') : new Date(to))
      : new Date();

    if (isNaN(fromDate) || isNaN(toDate)) {
      return res.json({ success: false, error: 'Invalid date range' });
    }

    const data = await analytics.getGeoStats(domain, fromDate, toDate, trafficType);
    res.json({ success: true, data });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ── GET /api/analytics/realtime ───────────────────────────────────────────────
// Returns number of distinct real-user IPs seen in the last 5 minutes.
// Query params:
//   domain  string  'all' or a specific domain  (default: 'all')
router.get('/realtime', async (req, res) => {
  try {
    const { domain = 'all' } = req.query;
    const data = await analytics.getRealtime(domain);
    res.json({ success: true, data });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

module.exports = router;
