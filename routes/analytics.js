'use strict';
/**
 * routes/analytics.js — DAnalytics REST API
 * Mount at: /api/analytics  (requireLogin applied in server.js)
 */
const express   = require('express');
const analytics = require('../lib/analytics');
const { pool }  = require('../lib/db');
const router    = express.Router();

// ── Shared: parse date params with timezone awareness ────────────────────────
function parseDateParams(req) {
  const tz  = req.query.tz || 'America/Chicago';
  const { from, to } = req.query;

  const fromDate = from
    ? analytics.parseLocalDate(from, tz)
    : new Date(Date.now() - 30 * 86400000);

  const toDate = to
    ? analytics.parseLocalEndOfDay(to, tz)
    : new Date();

  return { fromDate, toDate, tz };
}

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
//   from         YYYY-MM-DD start of range                 (default: 30 days ago)
//   to           YYYY-MM-DD end of range                   (default: today)
//   granularity  'hourly' | 'daily' | 'weekly' | 'monthly' (default: 'daily')
//   trafficType  'real' | 'bot' | 'crawler' | 'bots' | 'all'  (default: 'real')
//   tz           IANA timezone string                      (default: 'America/Chicago')
router.get('/stats', async (req, res) => {
  try {
    const {
      domain      = 'all',
      granularity = 'daily',
      trafficType = 'real',
    } = req.query;

    const { fromDate, toDate, tz } = parseDateParams(req);

    if (isNaN(fromDate) || isNaN(toDate)) {
      return res.json({ success: false, error: 'Invalid date range' });
    }

    const data = await analytics.getStats(domain, fromDate, toDate, granularity, trafficType, tz);
    res.json({ success: true, data });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ── GET /api/analytics/comparison ────────────────────────────────────────────
// Same params as /stats — returns { current: StatsResult, previous: StatsResult }
router.get('/comparison', async (req, res) => {
  try {
    const {
      domain      = 'all',
      granularity = 'daily',
      trafficType = 'real',
    } = req.query;

    const { fromDate, toDate, tz } = parseDateParams(req);

    if (isNaN(fromDate) || isNaN(toDate)) {
      return res.json({ success: false, error: 'Invalid date range' });
    }

    const data = await analytics.getComparisonStats(domain, fromDate, toDate, granularity, trafficType, tz);
    res.json({ success: true, data });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ── GET /api/analytics/geo ────────────────────────────────────────────────────
router.get('/geo', async (req, res) => {
  try {
    const { domain = 'all', trafficType = 'real' } = req.query;
    const { fromDate, toDate } = parseDateParams(req);

    if (isNaN(fromDate) || isNaN(toDate)) {
      return res.json({ success: false, error: 'Invalid date range' });
    }

    const data = await analytics.getGeoStats(domain, fromDate, toDate, trafficType);
    res.json({ success: true, data });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ── GET /api/analytics/errors ─────────────────────────────────────────────────
// Returns HTTP error breakdown (4xx/5xx) for the given domain + date range.
router.get('/errors', async (req, res) => {
  try {
    const { domain = 'all' } = req.query;
    const { fromDate, toDate } = parseDateParams(req);

    if (isNaN(fromDate) || isNaN(toDate)) {
      return res.json({ success: false, error: 'Invalid date range' });
    }

    const data = await analytics.getErrorStats(domain, fromDate, toDate);
    res.json({ success: true, data });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ── GET /api/analytics/page-drilldown ────────────────────────────────────────
// Query params: domain, url (required), from, to, tz
router.get('/page-drilldown', async (req, res) => {
  try {
    const { domain = 'all', url } = req.query;
    if (!url) return res.json({ success: false, error: 'url param is required' });

    const { fromDate, toDate, tz } = parseDateParams(req);
    const data = await analytics.getPageDrilldown(domain, url, fromDate, toDate, tz);
    if (!data) return res.json({ success: false, error: 'No data for that page' });
    res.json({ success: true, data });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ── GET /api/analytics/realtime ───────────────────────────────────────────────
router.get('/realtime', async (req, res) => {
  try {
    const { domain = 'all' } = req.query;
    const data = await analytics.getRealtime(domain);
    res.json({ success: true, data });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ── GET /api/analytics/health ─────────────────────────────────────────────────
router.get('/health', async (req, res) => {
  try {
    const data = await analytics.getHealthStatus();
    res.json({ success: true, data });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ── GET /api/analytics/export/csv ─────────────────────────────────────────────
// Downloads a CSV of the raw stats summary + timeseries for the given range.
router.get('/export/csv', async (req, res) => {
  try {
    const {
      domain      = 'all',
      granularity = 'daily',
      trafficType = 'real',
    } = req.query;

    const { fromDate, toDate, tz } = parseDateParams(req);

    if (isNaN(fromDate) || isNaN(toDate)) {
      return res.status(400).send('Invalid date range');
    }

    const data = await analytics.getStats(domain, fromDate, toDate, granularity, trafficType, tz);

    const filename = `analytics-${domain}-${fromDate.toISOString().slice(0,10)}-${toDate.toISOString().slice(0,10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    // Header row
    let csv = 'Date,Pageviews\r\n';
    for (const pt of data.timeSeries) {
      csv += `"${pt.date}",${pt.count}\r\n`;
    }
    csv += '\r\nSummary\r\n';
    csv += `Pageviews,${data.summary.pageviews}\r\n`;
    csv += `Unique Visitors,${data.summary.uniqueVisitors}\r\n`;
    csv += `Sessions,${data.summary.sessions}\r\n`;
    csv += `Bounce Rate,${data.summary.bounceRate}%\r\n`;
    csv += `Avg Duration (sec),${data.summary.avgDurationSec}\r\n`;
    csv += `\r\nTop Pages\r\nURL,Pageviews\r\n`;
    for (const p of data.topPages || []) {
      csv += `"${p.name.replace(/"/g, '""')}",${p.count}\r\n`;
    }
    csv += `\r\nTop Referrers\r\nDomain,Visits\r\n`;
    for (const r of data.referrers || []) {
      csv += `"${r.name.replace(/"/g, '""')}",${r.count}\r\n`;
    }

    res.send(csv);
  } catch (err) {
    res.status(500).send('Export failed: ' + err.message);
  }
});

// ── GET /api/analytics/reports ────────────────────────────────────────────────
router.get('/reports', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM analytics_report_subscriptions ORDER BY created_at DESC'
    );
    const data = rows.map(r => ({
      ...r,
      domains: JSON.parse(r.domains_json || '["*"]'),
    }));
    res.json({ success: true, data });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// ── POST /api/analytics/reports ───────────────────────────────────────────────
router.post('/reports', async (req, res) => {
  try {
    const { label, recipient_email, frequency = 'weekly', domains = ['*'] } = req.body;
    if (!label || !recipient_email) {
      return res.json({ success: false, error: 'label and recipient_email are required' });
    }
    if (!['daily', 'weekly', 'monthly'].includes(frequency)) {
      return res.json({ success: false, error: 'frequency must be daily, weekly, or monthly' });
    }
    const [result] = await pool.query(
      'INSERT INTO analytics_report_subscriptions (label, recipient_email, frequency, domains_json) VALUES (?, ?, ?, ?)',
      [label, recipient_email, frequency, JSON.stringify(domains)]
    );
    res.json({ success: true, id: result.insertId });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// ── PUT /api/analytics/reports/:id ───────────────────────────────────────────
router.put('/reports/:id', async (req, res) => {
  try {
    const { active, label, recipient_email, frequency, domains } = req.body;
    const updates = [];
    const values  = [];
    if (active !== undefined)     { updates.push('active = ?');           values.push(active ? 1 : 0); }
    if (label !== undefined)      { updates.push('label = ?');            values.push(label); }
    if (recipient_email !== undefined) { updates.push('recipient_email = ?'); values.push(recipient_email); }
    if (frequency !== undefined)  { updates.push('frequency = ?');        values.push(frequency); }
    if (domains !== undefined)    { updates.push('domains_json = ?');     values.push(JSON.stringify(domains)); }
    if (!updates.length) return res.json({ success: false, error: 'Nothing to update' });
    values.push(req.params.id);
    await pool.query(`UPDATE analytics_report_subscriptions SET ${updates.join(', ')} WHERE id = ?`, values);
    res.json({ success: true });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// ── DELETE /api/analytics/reports/:id ────────────────────────────────────────
router.delete('/reports/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM analytics_report_subscriptions WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// ── POST /api/analytics/reports/:id/send — send digest now ───────────────────
router.post('/reports/:id/send', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM analytics_report_subscriptions WHERE id = ?', [req.params.id]
    );
    if (!rows.length) return res.json({ success: false, error: 'Subscription not found' });
    const sub = rows[0];
    sub.domains = JSON.parse(sub.domains_json || '["*"]');
    const mailer = require('../lib/analytics-mailer');
    const result = await mailer.sendDigest(sub);
    res.json({ success: true, ...result });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

module.exports = router;
