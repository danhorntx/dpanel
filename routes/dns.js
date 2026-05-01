'use strict';
/**
 * routes/dns.js — REST API for DNS zone management
 *
 * Mount at: /api/dns
 */
const express = require('express');
const dns     = require('../lib/dns');
const apache  = require('../lib/apache');
const ssl     = require('../lib/ssl');
const router  = express.Router();

// ── GET /api/dns/zones  — list all managed zones ──────────────────────────────
router.get('/zones', (req, res) => {
  try {
    const zones = dns.listZones();
    res.json({ success: true, data: zones });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ── POST /api/dns/zones  — create a new zone ──────────────────────────────────
router.post('/zones', (req, res) => {
  try {
    const { domain, ip } = req.body;
    if (!domain) return res.json({ success: false, error: 'Domain is required' });
    if (dns.zoneExists(domain)) return res.json({ success: false, error: `Zone already exists for ${domain}` });
    const result = dns.createZone(domain, ip || dns.SERVER_IP);
    res.json({ success: true, data: result });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ── DELETE /api/dns/zones/:domain  — delete a zone ───────────────────────────
router.delete('/zones/:domain', (req, res) => {
  try {
    const { domain } = req.params;
    if (!dns.zoneExists(domain)) return res.json({ success: false, error: `Zone not found: ${domain}` });
    dns.deleteZone(domain);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ── GET /api/dns/zones/:domain/records  — get all records ─────────────────────
router.get('/zones/:domain/records', (req, res) => {
  try {
    const { domain } = req.params;
    if (!dns.zoneExists(domain)) return res.json({ success: false, error: `Zone not found: ${domain}` });
    const data = dns.getRecords(domain);
    res.json({ success: true, data });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ── POST /api/dns/zones/:domain/records  — add a record ──────────────────────
router.post('/zones/:domain/records', (req, res) => {
  try {
    const { domain } = req.params;
    const { name, ttl, type, value, priority } = req.body;
    if (!name || !type || !value) return res.json({ success: false, error: 'name, type, and value are required' });
    if (!dns.zoneExists(domain)) return res.json({ success: false, error: `Zone not found: ${domain}` });

    const record = {
      name,
      ttl:  ttl ? parseInt(ttl, 10) : 14400,
      type: type.toUpperCase(),
      value,
      ...(priority !== undefined ? { priority: parseInt(priority, 10) } : {}),
    };
    const result = dns.addRecord(domain, record);
    res.json({ success: true, data: result });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ── DELETE /api/dns/zones/:domain/records  — delete a record ─────────────────
router.delete('/zones/:domain/records', (req, res) => {
  try {
    const { domain } = req.params;
    const { name, type, value } = req.body;
    if (!name || !type) return res.json({ success: false, error: 'name and type are required' });
    if (!dns.zoneExists(domain)) return res.json({ success: false, error: `Zone not found: ${domain}` });
    const result = dns.deleteRecord(domain, { name, type, value });
    res.json({ success: true, data: result });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ── POST /api/dns/zones/:domain/mail-setup  — auto-configure mail DNS ────────
router.post('/zones/:domain/mail-setup', async (req, res) => {
  try {
    const { domain } = req.params;
    const applied = dns.setupMailDns(domain);

    let webmailResult = null;
    if (applied) {
      // Provision webmail.<domain> Apache vhost (proxy → DPanel)
      apache.createWebmailVhost(domain);
      // Best-effort SSL for webmail subdomain (may fail if DNS hasn't propagated yet)
      try {
        await ssl.autoSSL(`webmail.${domain}`, `admin@${domain}`);
        webmailResult = { url: `https://webmail.${domain}`, ssl: true };
      } catch (_) {
        webmailResult = { url: `http://webmail.${domain}`, ssl: false };
      }
    }

    res.json({ success: true, data: { applied, webmail: webmailResult } });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ── GET /api/dns/info  — nameserver info ──────────────────────────────────────
router.get('/info', (req, res) => {
  res.json({
    success: true,
    data: {
      ns1:      dns.NS1,
      ns2:      dns.NS2,
      serverIp: dns.SERVER_IP,
    },
  });
});

module.exports = router;
