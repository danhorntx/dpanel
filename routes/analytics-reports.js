'use strict';
/**
 * routes/analytics-reports.js — Analytics email report subscriptions
 * Mount at: /api/analytics/reports  (requireLogin in server.js)
 */
const express = require('express');
const { pool } = require('../lib/db');
const mailer   = require('../lib/analytics-mailer');
const router   = express.Router();

// ── GET /api/analytics/reports ────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, label, domains_json, recipient_email, frequency, day_of_week,
              last_sent, active, created_at
       FROM analytics_report_subscriptions ORDER BY created_at DESC`
    );
    res.json({
      success: true,
      data: rows.map(r => ({
        ...r,
        domains: JSON.parse(r.domains_json || '["*"]'),
      })),
    });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ── POST /api/analytics/reports ───────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const {
      label,
      domains = ['*'],
      recipient_email,
      frequency  = 'weekly',
      day_of_week = 1,
      active     = 1,
    } = req.body;

    if (!label)           return res.json({ success: false, error: 'label is required' });
    if (!recipient_email) return res.json({ success: false, error: 'recipient_email is required' });
    if (!['daily','weekly','monthly'].includes(frequency))
      return res.json({ success: false, error: 'frequency must be daily, weekly, or monthly' });

    const [result] = await pool.query(
      `INSERT INTO analytics_report_subscriptions
         (label, domains_json, recipient_email, frequency, day_of_week, active)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [label, JSON.stringify(domains), recipient_email, frequency, day_of_week, active ? 1 : 0]
    );

    res.json({ success: true, id: result.insertId });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ── PUT /api/analytics/reports/:id ───────────────────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      label, domains, recipient_email, frequency, day_of_week, active,
    } = req.body;

    const updates = [];
    const params  = [];

    if (label           !== undefined) { updates.push('label = ?');           params.push(label); }
    if (domains         !== undefined) { updates.push('domains_json = ?');     params.push(JSON.stringify(domains)); }
    if (recipient_email !== undefined) { updates.push('recipient_email = ?');  params.push(recipient_email); }
    if (frequency       !== undefined) { updates.push('frequency = ?');        params.push(frequency); }
    if (day_of_week     !== undefined) { updates.push('day_of_week = ?');      params.push(day_of_week); }
    if (active          !== undefined) { updates.push('active = ?');           params.push(active ? 1 : 0); }

    if (!updates.length) return res.json({ success: false, error: 'Nothing to update' });

    params.push(id);
    await pool.query(`UPDATE analytics_report_subscriptions SET ${updates.join(', ')} WHERE id = ?`, params);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ── DELETE /api/analytics/reports/:id ────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM analytics_report_subscriptions WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ── POST /api/analytics/reports/:id/send — manual trigger ─────────────────────
router.post('/:id/send', async (req, res) => {
  try {
    const [[sub]] = await pool.query(
      'SELECT * FROM analytics_report_subscriptions WHERE id = ?',
      [req.params.id]
    );
    if (!sub) return res.json({ success: false, error: 'Subscription not found' });

    sub.domains = JSON.parse(sub.domains_json || '["*"]');
    const result = await mailer.sendDigest(sub);
    res.json({ success: true, result });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

module.exports = router;
