'use strict';
const express    = require('express');
const mail       = require('../lib/mail');
const dkim       = require('../lib/dkim');
const dns        = require('../lib/dns');
const mailsetup  = require('../lib/mailsetup');
const router     = express.Router();

// ── Accounts ──────────────────────────────────────────────────────────────────
router.get('/accounts', (req, res) => {
  try { res.json({ success: true, data: mail.listAccounts() }); }
  catch (err) { res.json({ success: false, error: err.message }); }
});

router.post('/accounts', async (req, res) => {
  try {
    const { email, password, quota } = req.body;
    if (!email || !password) return res.json({ success: false, error: 'Email and password required' });
    await mail.addAccount(email, password, quota);

    // Auto-configure mail DNS + autoconfig subdomains if we manage a zone for this domain
    const domain = email.split('@')[1];
    if (domain) {
      try { dns.setupMailDns(domain); } catch (_) { /* non-fatal */ }
      // Fire-and-forget: create autoconfig vhost + DNS + SSL in background
      mailsetup.setupMailAutoconfig(domain).catch(() => {});
    }

    res.json({ success: true });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

router.put('/accounts/:email', async (req, res) => {
  try {
    const { password, quota } = req.body;
    if (quota) {
      mail.updateQuota(req.params.email, quota);
      return res.json({ success: true });
    }
    if (!password) return res.json({ success: false, error: 'Password required' });
    await mail.changePassword(req.params.email, password);
    res.json({ success: true });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

router.delete('/accounts/:email', (req, res) => {
  try { mail.deleteAccount(req.params.email); res.json({ success: true }); }
  catch (err) { res.json({ success: false, error: err.message }); }
});

// ── Forwards ──────────────────────────────────────────────────────────────────
router.get('/forwards', (req, res) => {
  try { res.json({ success: true, data: mail.listForwards() }); }
  catch (err) { res.json({ success: false, error: err.message }); }
});

router.post('/forwards', (req, res) => {
  try {
    const { source, destinations } = req.body;
    if (!source || !destinations) return res.json({ success: false, error: 'Source and destinations required' });
    mail.addForward(source, destinations);
    res.json({ success: true });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

router.delete('/forwards/:source', (req, res) => {
  try { mail.deleteForward(req.params.source); res.json({ success: true }); }
  catch (err) { res.json({ success: false, error: err.message }); }
});

// ── DKIM ──────────────────────────────────────────────────────────────────────
// GET /api/mail/dkim/:domain  → check status + public key
router.get('/dkim/:domain', (req, res) => {
  try {
    const { domain } = req.params;
    const has = dkim.hasDkim(domain);
    const pub = has ? dkim.getPublicKey(domain) : null;
    res.json({ success: true, data: { enabled: has, publicKey: pub } });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// POST /api/mail/dkim/:domain  → generate key pair + auto-publish to zone
router.post('/dkim/:domain', async (req, res) => {
  try {
    const { domain } = req.params;
    const pub = await dkim.generateKey(domain);
    // Auto-publish DKIM TXT record if we manage a zone for this domain
    if (dns.zoneExists(domain)) {
      try {
        const bare = dkim.getBareKey(domain);
        if (bare) {
          // Remove stale entry first (idempotent)
          try { dns.deleteRecord(domain, { name: 'mail._domainkey', type: 'TXT' }); } catch (_) {}
          dns.addDkimRecord(domain, bare, 'mail');
        }
      } catch (_) { /* non-fatal: zone publish failure shouldn't block response */ }
    }
    res.json({ success: true, data: { publicKey: pub } });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// DELETE /api/mail/dkim/:domain  → remove DKIM for domain
router.delete('/dkim/:domain', (req, res) => {
  try {
    dkim.removeKey(req.params.domain);
    res.json({ success: true });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// ── Auto Mail Config (subdomains + SSL + static files) ───────────────────────
// POST /api/mail/autoconfig/:domain  → run full setup (idempotent)
router.post('/autoconfig/:domain', async (req, res) => {
  try {
    const result = await mailsetup.setupMailAutoconfig(req.params.domain);
    res.json({ success: true, data: result });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// GET /api/mail/autoconfig/:domain  → return auto-config URLs for the domain
router.get('/autoconfig/:domain', (req, res) => {
  try {
    const urls = mailsetup.getAutoconfigUrls(req.params.domain);
    res.json({ success: true, data: urls });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// ── Zone Repair ───────────────────────────────────────────────────────────────
// POST /api/mail/repair/:domain  → check and fix all mail config for a domain
router.post('/repair/:domain', async (req, res) => {
  const { domain } = req.params;
  const { execSync } = require('child_process');
  const fs = require('fs');
  const fixes = [];
  const issues = [];

  try {
    // 1. DNS zone — MX, SPF, DMARC
    if (dns.zoneExists(domain)) {
      try {
        dns.setupMailDns(domain);
        fixes.push('DNS zone mail records refreshed (MX, SPF, DMARC)');
      } catch (e) { issues.push(`DNS zone update failed: ${e.message}`); }
    } else {
      issues.push('No DNS zone found — domain must use our nameservers for DNS auto-repair');
    }

    // 2. DKIM key — generate if missing
    if (!dkim.hasDkim(domain)) {
      try {
        await dkim.generateKey(domain);
        fixes.push('DKIM key generated');
      } catch (e) { issues.push(`DKIM keygen failed: ${e.message}`); }
    }

    // 3. Wire DKIM into OpenDKIM signing/key tables
    const keyTablePath  = '/etc/opendkim/KeyTable';
    const signTablePath = '/etc/opendkim/SigningTable';
    const keyPriv = `/etc/opendkim/keys/${domain}/mail.private`;
    if (fs.existsSync(keyPriv)) {
      const ktEntry  = `mail._domainkey.${domain} ${domain}:mail:${keyPriv}`;
      const stEntry  = `*@${domain} mail._domainkey.${domain}`;
      const kt = fs.existsSync(keyTablePath)  ? fs.readFileSync(keyTablePath,  'utf8') : '';
      const st = fs.existsSync(signTablePath) ? fs.readFileSync(signTablePath, 'utf8') : '';
      if (!kt.includes(domain)) {
        fs.appendFileSync(keyTablePath, '\n' + ktEntry + '\n');
        fixes.push('DKIM wired into KeyTable');
      }
      if (!st.includes(domain)) {
        fs.appendFileSync(signTablePath, '\n' + stEntry + '\n');
        fixes.push('DKIM wired into SigningTable');
      }

      // 4. Add DKIM TXT record to zone if missing
      if (dns.zoneExists(domain)) {
        try {
          const bare = dkim.getBareKey(domain);
          if (bare) {
            // Remove old entry and re-add using addDkimRecord (handles chunking)
            try { dns.deleteRecord(domain, { name: 'mail._domainkey', type: 'TXT' }); } catch (_) {}
            dns.addDkimRecord(domain, bare, 'mail');
            fixes.push('DKIM TXT record added to DNS zone');
          }
        } catch (e) { issues.push(`DKIM DNS record failed: ${e.message}`); }
      }

      // Restart opendkim to pick up table changes
      try { execSync('systemctl restart opendkim', { timeout: 10000 }); fixes.push('OpenDKIM restarted'); }
      catch (e) { issues.push(`OpenDKIM restart failed: ${e.message}`); }
    }

    // 5. Postfix vdomains — ensure domain is accepted
    const accounts = require('../lib/mail').listAccounts().filter(a => a.email.endsWith('@' + domain));
    if (accounts.length > 0) {
      try {
        const vd = fs.existsSync('/etc/postfix/vdomains') ? fs.readFileSync('/etc/postfix/vdomains', 'utf8') : '';
        if (!vd.split('\n').some(l => l.split(/\s+/)[0] === domain)) {
          fs.appendFileSync('/etc/postfix/vdomains', `${domain}    OK\n`);
          execSync('postmap /etc/postfix/vdomains');
          fixes.push('Domain added to Postfix vdomains');
        }
      } catch (e) { issues.push(`Postfix vdomains: ${e.message}`); }
    }

    // 6. SSL cert for mail.domain
    const certPath = `/etc/letsencrypt/live/mail.${domain}/fullchain.pem`;
    if (!fs.existsSync(certPath)) {
      try {
        // Ensure Apache vhost exists for ACME challenge
        const vhostPath = `/etc/apache2/sites-available/mail.${domain}.conf`;
        if (!fs.existsSync(vhostPath)) {
          fs.writeFileSync(vhostPath, `<VirtualHost *:80>\n    ServerName mail.${domain}\n    ServerAlias webmail.${domain}\n    DocumentRoot /var/www/html\n    Alias /.well-known/acme-challenge/ /var/www/html/.well-known/acme-challenge/\n    <Directory /var/www/html/.well-known/acme-challenge/>\n        Options None\n        AllowOverride None\n        Require all granted\n    </Directory>\n</VirtualHost>\n`);
          execSync(`a2ensite mail.${domain}.conf && systemctl reload apache2`);
        }
        execSync(`certbot certonly --webroot -w /var/www/html --non-interactive --agree-tos -m danhorntx@gmail.com -d mail.${domain} -d webmail.${domain} 2>&1`, { timeout: 60000 });
        fixes.push(`SSL certificate issued for mail.${domain}`);
      } catch (e) { issues.push(`SSL cert failed: ${e.message.split('\n')[0]}`); }
    }

    // 7. Reload Postfix + Dovecot
    try { execSync('systemctl reload postfix dovecot', { timeout: 10000 }); }
    catch (_) {}

    // 8. Run mailsetup autoconfig (idempotent)
    try { await mailsetup.setupMailAutoconfig(domain); fixes.push('Autoconfig subdomains verified'); }
    catch (_) {}

    res.json({ success: true, data: { fixes, issues } });
  } catch (err) {
    res.json({ success: false, error: err.message, data: { fixes, issues } });
  }
});

// ── DNS Records ───────────────────────────────────────────────────────────────
// GET /api/mail/dns/:domain  → recommended DNS records for email
router.get('/dns/:domain', async (req, res) => {
  try {
    const { domain } = req.params;
    // Detect server IP
    let serverIp = '';
    try {
      const { execSync } = require('child_process');
      serverIp = execSync('curl -sf https://api.ipify.org || hostname -I | awk \'{print $1}\'', { timeout: 5000 }).toString().trim();
    } catch (_) {}
    const records  = dkim.getDnsRecords(domain, serverIp);
    const verified = await dkim.verifyDns(domain);
    res.json({ success: true, data: { records, verified } });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

module.exports = router;
