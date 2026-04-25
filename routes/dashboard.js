'use strict';
const express = require('express');
const si = require('systeminformation');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const router = express.Router();

const LOG_FILE = path.join(__dirname, '..', 'logs', 'panel.log');

function serviceStatus(name) {
  try {
    const out = execSync(`systemctl is-active ${name}`, { encoding: 'utf8' }).trim();
    return out === 'active';
  } catch (_) { return false; }
}

router.get('/stats', async (req, res) => {
  try {
    const [cpu, mem, disk, time] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.fsSize(),
      si.time()
    ]);

    const rootDisk = disk.find(d => d.mount === '/') || disk[0];
    const services = {
      apache2:      serviceStatus('apache2'),
      postfix:      serviceStatus('postfix'),
      dovecot:      serviceStatus('dovecot'),
      spamassassin: serviceStatus('spamassassin') || serviceStatus('spamd'),
    };

    res.json({
      success: true,
      data: {
        cpu:     Math.round(cpu.currentLoad),
        ram:     { used: mem.active, total: mem.total },
        disk:    rootDisk ? { used: rootDisk.used, size: rootDisk.size, use: rootDisk.use } : null,
        uptime:  time.uptime,
        services
      }
    });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

router.get('/log', (req, res) => {
  try {
    if (!fs.existsSync(LOG_FILE)) return res.json({ success: true, data: [] });
    const lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean);
    const last10 = lines.slice(-10).reverse().map(l => { try { return JSON.parse(l); } catch(_){ return { ts: '', action: l, target: '', result: '' }; } });
    res.json({ success: true, data: last10 });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

module.exports = router;
