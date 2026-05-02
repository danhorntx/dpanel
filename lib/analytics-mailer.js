'use strict';
/**
 * lib/analytics-mailer.js — Analytics email digest sender
 *
 * Uses nodemailer with the server's local Postfix MTA (sendmail transport).
 * From address: reports@danhorntx.com (configured via REPORTS_FROM env or config.json)
 *
 * Public API:
 *   sendDigest(subscription) → Promise<{ success, to, subject }>
 *   checkAndSendDueReports() → Promise<void>
 */

const nodemailer = require('nodemailer');
const { pool }   = require('./db');
const analytics  = require('./analytics');
const fs         = require('fs');
const path       = require('path');

const CONFIG_FILE    = path.join(__dirname, '..', 'config.json');
const DEFAULT_FROM   = process.env.REPORTS_FROM || 'reports@danhorntx.com';
const PANEL_BASE_URL = process.env.PANEL_BASE_URL || 'https://dpanel.danhorntx.com';

// ── Transporter ───────────────────────────────────────────────────────────────
function getTransporter() {
  // Use local Postfix sendmail — no external SMTP credentials needed
  return nodemailer.createTransport({
    sendmail: true,
    newline:  'unix',
    path:     '/usr/sbin/sendmail',
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtNum(n) {
  if (!n) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 10000)   return (n / 1000).toFixed(0)    + 'K';
  if (n >= 1000)    return (n / 1000).toFixed(1)    + 'K';
  return String(n);
}

function fmtDuration(sec) {
  if (!sec) return '—';
  if (sec >= 3600) return `${Math.floor(sec/3600)}h ${Math.floor((sec%3600)/60)}m`;
  if (sec >= 60)   return `${Math.floor(sec/60)}m ${sec%60}s`;
  return `${sec}s`;
}

function deltaArrow(current, previous) {
  if (!previous || previous === 0) return '';
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct > 0)  return `<span style="color:#3dd68c">▲ ${pct}%</span>`;
  if (pct < 0)  return `<span style="color:#f75f5f">▼ ${Math.abs(pct)}%</span>`;
  return `<span style="color:#7a86a0">— 0%</span>`;
}

// ── Build HTML email template ─────────────────────────────────────────────────
function buildDigestHtml(subscription, compData, dateRange, domainLabel) {
  const { current, previous } = compData;
  const s = current.summary;
  const p = previous?.summary;

  const topPages = (current.topPages || []).slice(0, 5);
  const topRefs  = (current.referrers || []).slice(0, 5);

  const pagesHtml = topPages.length
    ? topPages.map((pg, i) => `
        <tr>
          <td style="padding:8px 0;border-bottom:1px solid #1e2535;color:#7a86a0;font-size:0.75rem;width:20px">${i+1}</td>
          <td style="padding:8px 0;border-bottom:1px solid #1e2535;color:#c8d0e0;font-size:0.8125rem;font-family:monospace">${pg.name}</td>
          <td style="padding:8px 0;border-bottom:1px solid #1e2535;color:#e4e8f0;font-size:0.8125rem;text-align:right;font-weight:600">${fmtNum(pg.count)}</td>
        </tr>`).join('')
    : `<tr><td colspan="3" style="padding:12px 0;color:#7a86a0;font-size:0.8rem">No page data</td></tr>`;

  const refsHtml = topRefs.length
    ? topRefs.map((r, i) => `
        <tr>
          <td style="padding:8px 0;border-bottom:1px solid #1e2535;color:#7a86a0;font-size:0.75rem;width:20px">${i+1}</td>
          <td style="padding:8px 0;border-bottom:1px solid #1e2535;color:#4f8ef7;font-size:0.8125rem;font-family:monospace">${r.name}</td>
          <td style="padding:8px 0;border-bottom:1px solid #1e2535;color:#e4e8f0;font-size:0.8125rem;text-align:right;font-weight:600">${fmtNum(r.count)}</td>
        </tr>`).join('')
    : `<tr><td colspan="3" style="padding:12px 0;color:#7a86a0;font-size:0.8rem">No referrer data</td></tr>`;

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>DAnalytics Report</title></head>
<body style="margin:0;padding:0;background:#0d1117;font-family:'Segoe UI',Arial,sans-serif">
  <div style="max-width:600px;margin:0 auto;padding:32px 16px">

    <!-- Header -->
    <div style="margin-bottom:32px">
      <div style="font-size:1.75rem;font-weight:800;letter-spacing:-0.05em;color:#4f8ef7;margin-bottom:4px">D/ Analytics Report</div>
      <div style="font-size:0.8125rem;color:#7a86a0">${subscription.label} · ${dateRange}</div>
      <div style="font-size:0.75rem;color:#4a5568;margin-top:4px">Domain: <span style="color:#c8d0e0">${domainLabel}</span></div>
    </div>

    <!-- KPI cards -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:28px">
      <div style="background:#141820;border:1px solid #1e2535;border-radius:10px;padding:18px">
        <div style="font-size:0.75rem;color:#7a86a0;margin-bottom:6px;text-transform:uppercase;letter-spacing:.05em">Page Views</div>
        <div style="font-size:2rem;font-weight:700;color:#e4e8f0;letter-spacing:-0.04em">${fmtNum(s.pageviews)}</div>
        ${p ? `<div style="font-size:0.75rem;margin-top:4px">${deltaArrow(s.pageviews, p.pageviews)} vs last period</div>` : ''}
      </div>
      <div style="background:#141820;border:1px solid #1e2535;border-radius:10px;padding:18px">
        <div style="font-size:0.75rem;color:#7a86a0;margin-bottom:6px;text-transform:uppercase;letter-spacing:.05em">Unique Visitors</div>
        <div style="font-size:2rem;font-weight:700;color:#e4e8f0;letter-spacing:-0.04em">${fmtNum(s.uniqueVisitors)}</div>
        ${p ? `<div style="font-size:0.75rem;margin-top:4px">${deltaArrow(s.uniqueVisitors, p.uniqueVisitors)} vs last period</div>` : ''}
      </div>
      <div style="background:#141820;border:1px solid #1e2535;border-radius:10px;padding:18px">
        <div style="font-size:0.75rem;color:#7a86a0;margin-bottom:6px;text-transform:uppercase;letter-spacing:.05em">Bounce Rate</div>
        <div style="font-size:2rem;font-weight:700;color:${s.bounceRate > 70 ? '#f75f5f' : '#e4e8f0'};letter-spacing:-0.04em">${s.bounceRate}%</div>
        ${p ? `<div style="font-size:0.75rem;margin-top:4px">${deltaArrow(p.bounceRate, s.bounceRate)} vs last period</div>` : ''}
      </div>
      <div style="background:#141820;border:1px solid #1e2535;border-radius:10px;padding:18px">
        <div style="font-size:0.75rem;color:#7a86a0;margin-bottom:6px;text-transform:uppercase;letter-spacing:.05em">Avg Duration</div>
        <div style="font-size:2rem;font-weight:700;color:#e4e8f0;letter-spacing:-0.04em">${fmtDuration(s.avgDurationSec)}</div>
        ${p ? `<div style="font-size:0.75rem;margin-top:4px">${deltaArrow(s.avgDurationSec, p.avgDurationSec)} vs last period</div>` : ''}
      </div>
    </div>

    <!-- Top Pages -->
    <div style="background:#141820;border:1px solid #1e2535;border-radius:10px;padding:20px;margin-bottom:16px">
      <div style="font-size:0.9375rem;font-weight:600;color:#e4e8f0;margin-bottom:14px">Top Pages</div>
      <table style="width:100%;border-collapse:collapse">
        <tbody>${pagesHtml}</tbody>
      </table>
    </div>

    <!-- Top Referrers -->
    <div style="background:#141820;border:1px solid #1e2535;border-radius:10px;padding:20px;margin-bottom:28px">
      <div style="font-size:0.9375rem;font-weight:600;color:#e4e8f0;margin-bottom:14px">Top Referrers</div>
      <table style="width:100%;border-collapse:collapse">
        <tbody>${refsHtml}</tbody>
      </table>
    </div>

    <!-- CTA -->
    <div style="text-align:center;margin-bottom:28px">
      <a href="${PANEL_BASE_URL}" style="display:inline-block;background:#4f8ef7;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:0.9rem">
        View Full Dashboard →
      </a>
    </div>

    <!-- Footer -->
    <div style="text-align:center;font-size:0.72rem;color:#4a5568;border-top:1px solid #1e2535;padding-top:20px">
      Sent by DPanel DAnalytics · <a href="${PANEL_BASE_URL}" style="color:#4f8ef7;text-decoration:none">Manage subscriptions</a>
    </div>
  </div>
</body>
</html>`;
}

// ── Compute date range for a subscription ─────────────────────────────────────
function getDateRange(frequency) {
  const now   = new Date();
  const today = now.toISOString().slice(0, 10);

  if (frequency === 'daily') {
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    return { from: yesterday, to: yesterday, label: `Yesterday (${yesterday})` };
  }
  if (frequency === 'weekly') {
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    return { from: weekAgo, to: today, label: `Last 7 days (${weekAgo} → ${today})` };
  }
  // monthly
  const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  return { from: monthAgo, to: today, label: `Last 30 days (${monthAgo} → ${today})` };
}

// ── Send a single digest ──────────────────────────────────────────────────────
async function sendDigest(subscription) {
  const domains = subscription.domains || ['*'];
  const isAll   = domains.includes('*') || domains.length === 0;

  // Resolve domain list
  let domainList = [];
  if (isAll) {
    const { listLogDomains } = analytics;
    domainList = listLogDomains();
  } else {
    domainList = domains;
  }

  const { from, to, label: dateRangeLabel } = getDateRange(subscription.frequency);
  const tz = 'America/Chicago';

  const fromDate = analytics.parseLocalDate(from, tz);
  const toDate   = analytics.parseLocalEndOfDay(to, tz);

  // Use 'all' domain if multiple, else specific domain
  const queryDomain = domainList.length === 1 ? domainList[0] : 'all';
  const domainLabel = isAll
    ? 'All Domains'
    : domainList.join(', ');

  const compData = await analytics.getComparisonStats(
    queryDomain, fromDate, toDate, 'daily', 'real', tz
  );

  const html    = buildDigestHtml(subscription, compData, dateRangeLabel, domainLabel);
  const subject = `DAnalytics: ${subscription.label} — ${dateRangeLabel}`;

  const transporter = getTransporter();
  await transporter.sendMail({
    from:    DEFAULT_FROM,
    to:      subscription.recipient_email,
    subject,
    html,
  });

  // Update last_sent
  await pool.query(
    'UPDATE analytics_report_subscriptions SET last_sent = NOW() WHERE id = ?',
    [subscription.id]
  );

  console.log(`[analytics-mailer] Sent digest "${subscription.label}" to ${subscription.recipient_email}`);
  return { success: true, to: subscription.recipient_email, subject };
}

// ── Check and send all due reports ────────────────────────────────────────────
async function checkAndSendDueReports() {
  try {
    const [subs] = await pool.query(
      `SELECT * FROM analytics_report_subscriptions WHERE active = 1`
    );

    const now     = new Date();
    const todayUTC = now.toISOString().slice(0, 10);
    const dowUTC   = now.getUTCDay(); // 0=Sun, 1=Mon, ...
    const domUTC   = now.getUTCDate();

    for (const sub of subs) {
      try {
        sub.domains = JSON.parse(sub.domains_json || '["*"]');
        const lastSentDate = sub.last_sent ? new Date(sub.last_sent).toISOString().slice(0, 10) : null;

        // Already sent today
        if (lastSentDate === todayUTC) continue;

        let shouldSend = false;
        if (sub.frequency === 'daily') {
          shouldSend = true;
        } else if (sub.frequency === 'weekly') {
          // Send on the configured day_of_week (0=Sun, 1=Mon, ...)
          shouldSend = dowUTC === (sub.day_of_week || 1);
        } else if (sub.frequency === 'monthly') {
          // Send on day 1 of each month
          shouldSend = domUTC === 1;
        }

        if (shouldSend) {
          await sendDigest(sub);
        }
      } catch (err) {
        console.error(`[analytics-mailer] Error sending digest for subscription ${sub.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[analytics-mailer] checkAndSendDueReports error:', err.message);
  }
}

module.exports = { sendDigest, checkAndSendDueReports, buildDigestHtml };
