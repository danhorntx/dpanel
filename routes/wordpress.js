'use strict';
const express   = require('express');
const crypto    = require('crypto');
const wp        = require('../lib/wordpress');
const apache    = require('../lib/apache');
const mysql     = require('../lib/mysql');
const router    = express.Router();

function genPw(len = 16) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$';
  return Array.from(crypto.randomBytes(len)).map(b => chars[b % chars.length]).join('');
}

// GET /api/wordpress — list WordPress installs
router.get('/', (req, res) => {
  try {
    const vhosts = apache.listVhosts().filter(v => !v.domain.endsWith('-le-ssl'));
    const installs = vhosts.map(v => ({
      domain:    v.domain,
      docRoot:   v.docRoot,
      installed: wp.isInstalled(v.docRoot),
      version:   wp.isInstalled(v.docRoot) ? wp.getVersion(v.docRoot) : null,
    }));
    res.json({ success: true, data: { installs, mysqlInstalled: mysql.isInstalled() } });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// POST /api/wordpress/install — async via job queue. Returns a jobId
// immediately; client polls /api/jobs/:id until state='done' and reads the
// credentials from job.result.
router.post('/install', async (req, res) => {
  try {
    const { domain, adminUser, adminEmail, siteTitle } = req.body;
    if (!domain) return res.json({ success: false, error: 'Domain required.' });

    const vhosts = apache.listVhosts().filter(v => !v.domain.endsWith('-le-ssl'));
    const vhost  = vhosts.find(v => v.domain === domain);
    if (!vhost) return res.json({ success: false, error: 'Domain not found.' });

    const base        = domain.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 16);
    const dbName      = req.body.dbName      || `wp_${base}`;
    const dbUser      = req.body.dbUser      || `wp_${base}`;
    const dbPassword  = req.body.dbPassword  || genPw(20);
    const adminPassword = req.body.adminPassword || genPw(16);

    const jobs = require('../lib/jobqueue');
    const jobId = jobs.enqueue(`wordpress-install:${domain}`, async (job) => {
      job.setProgress(10, 'Preparing database…');
      job.addLog(`Installing WordPress for ${domain} → ${vhost.docRoot}`);
      job.setProgress(30, 'Downloading WordPress core…');
      await wp.install({
        domain,
        docRoot:       vhost.docRoot,
        dbName,
        dbUser,
        dbPassword,
        adminUser:     adminUser || 'admin',
        adminPassword,
        adminEmail:    adminEmail || `admin@${domain}`,
        siteTitle:     siteTitle || domain,
      });
      job.setProgress(100, 'Done');
      return { domain, dbName, dbUser, dbPassword, adminUser: adminUser || 'admin', adminPassword };
    }, { domain });

    res.json({ success: true, jobId });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

module.exports = router;
