'use strict';
const express     = require('express');
const { execSync } = require('child_process');
const fs          = require('fs');
const path        = require('path');
const apache      = require('../lib/apache');
const domainState = require('../lib/state/domain');
const { pool }    = require('../lib/db');
const router      = express.Router();

// ── GET /api/domains ──────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  try {
    const HIDDEN_SUFFIXES = ['-le-ssl', '000-default', 'default-ssl'];
    const HIDDEN_PREFIXES = ['autoconfig.', 'autodiscover.', 'webmail.'];
    const vhosts = apache.listVhosts().filter(v =>
      !HIDDEN_SUFFIXES.some(h => v.domain.endsWith(h)) &&
      !HIDDEN_PREFIXES.some(h => v.domain.startsWith(h))
    );
    res.json({ success: true, data: vhosts });
  }
  catch (err) { res.json({ success: false, error: err.message }); }
});

// ── POST /api/domains — atomic provisioning via state reconciler ─────────────
// Body: { domain, docRoot?, setupMailDns? }
//   setupMailDns=true → also configure mail DNS, autoconfig subdomains, webmail vhost+SSL
router.post('/', async (req, res) => {
  const { domain, docRoot, setupMailDns } = req.body;
  if (!domain) return res.json({ success: false, error: 'Domain name is required.' });

  const spec = {
    domain,
    docRoot,
    withSftp: true,
    withDns:  true,
    withSsl:  true,
    mail:     setupMailDns ? { enabled: true, autoconfig: true, webmail: true } : { enabled: false },
  };

  try {
    const result = await domainState.create(spec);
    // Backward-compat: clients expect { success, credentials } for success and
    // { success:false, error } for failure. Also include the new structured
    // steps array so the upcoming progress UI (ticket 1.4) can render it.
    if (!result.success) {
      return res.json({
        success:    false,
        error:      result.error,
        steps:      result.steps,
        rolledBack: result.rolledBack,
      });
    }
    res.json({
      success:     true,
      credentials: result.credentials,
      steps:       result.steps,
    });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ── PUT /api/domains/:domain ──────────────────────────────────────────────────
router.put('/:domain', (req, res) => {
  try {
    apache.updateVhost(req.params.domain, req.body.content);
    res.json({ success: true });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// ── POST /api/domains/:domain/enable ─────────────────────────────────────────
router.post('/:domain/enable', (req, res) => {
  try { apache.enableVhost(req.params.domain); res.json({ success: true }); }
  catch (err) { res.json({ success: false, error: err.message }); }
});

// ── POST /api/domains/:domain/disable ────────────────────────────────────────
router.post('/:domain/disable', (req, res) => {
  try { apache.disableVhost(req.params.domain); res.json({ success: true }); }
  catch (err) { res.json({ success: false, error: err.message }); }
});

// ── DELETE /api/domains/:domain ───────────────────────────────────────────────
// Best-effort teardown via the state reconciler: vhost, webmail vhost, DNS
// (subdomain A record only — apex zones preserved), and any SFTP accounts.
router.delete('/:domain', async (req, res) => {
  try {
    const result = await domainState.destroy(req.params.domain);
    res.json({ success: result.success, steps: result.steps });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// ── GET /api/domains/:domain/config ──────────────────────────────────────────
router.get('/:domain/config', (req, res) => {
  try { res.json({ success: true, data: apache.getVhostConfig(req.params.domain) }); }
  catch (err) { res.json({ success: false, error: err.message }); }
});

// ── Redirect helpers ──────────────────────────────────────────────────────────
const HTACCESS_START = '# BEGIN DPanel-Redirects';
const HTACCESS_END   = '# END DPanel-Redirects';

function getDocRoot(domain) {
  const { sanitizeDomain } = require('../lib/shell');
  sanitizeDomain(domain);
  const HIDDEN = ['-le-ssl', '000-default', 'default-ssl'];
  const vhosts = apache.listVhosts().filter(v => !HIDDEN.some(h => v.domain.endsWith(h)));
  const vhost  = vhosts.find(v => v.domain === domain);
  if (!vhost?.docRoot) throw new Error('Domain not found');
  return vhost.docRoot;
}

async function writeHtaccessBlock(domain, redirects) {
  const docRoot    = getDocRoot(domain);
  const htFile     = path.join(docRoot, '.htaccess');
  let existing     = '';
  if (fs.existsSync(htFile)) existing = fs.readFileSync(htFile, 'utf8');

  // Remove old DPanel block
  const startIdx = existing.indexOf(HTACCESS_START);
  const endIdx   = existing.indexOf(HTACCESS_END);
  if (startIdx !== -1 && endIdx !== -1) {
    existing = (existing.slice(0, startIdx) + existing.slice(endIdx + HTACCESS_END.length)).trim();
  }

  if (!redirects.length) {
    fs.writeFileSync(htFile, existing || '');
    return;
  }

  const lines = redirects.map(r => `Redirect ${r.type} ${r.from_path} ${r.to_url}`).join('\n');
  const block  = `\n${HTACCESS_START}\n${lines}\n${HTACCESS_END}\n`;
  fs.writeFileSync(htFile, (existing ? existing + '\n' : '') + block);
}

// ── GET /api/domains/:domain/redirects ────────────────────────────────────────
router.get('/:domain/redirects', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM dpanel_redirects WHERE domain = ? ORDER BY id',
      [req.params.domain]
    );
    res.json({ success: true, data: rows });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// ── POST /api/domains/:domain/redirects — add redirect ────────────────────────
router.post('/:domain/redirects', async (req, res) => {
  try {
    const domain    = req.params.domain;
    const { from_path, to_url, type = 301 } = req.body;
    if (!from_path || !to_url) return res.json({ success: false, error: 'from_path and to_url are required' });
    if (![301, 302].includes(Number(type))) return res.json({ success: false, error: 'type must be 301 or 302' });
    if (!from_path.startsWith('/')) return res.json({ success: false, error: 'from_path must start with /' });

    await pool.query(
      'INSERT INTO dpanel_redirects (domain, from_path, to_url, type) VALUES (?, ?, ?, ?)',
      [domain, from_path, to_url, type]
    );
    const [all] = await pool.query('SELECT * FROM dpanel_redirects WHERE domain = ? ORDER BY id', [domain]);
    await writeHtaccessBlock(domain, all);
    res.json({ success: true });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// ── DELETE /api/domains/:domain/redirects/:id ─────────────────────────────────
router.delete('/:domain/redirects/:id', async (req, res) => {
  try {
    const domain = req.params.domain;
    await pool.query('DELETE FROM dpanel_redirects WHERE id = ? AND domain = ?', [req.params.id, domain]);
    const [all] = await pool.query('SELECT * FROM dpanel_redirects WHERE domain = ? ORDER BY id', [domain]);
    await writeHtaccessBlock(domain, all);
    res.json({ success: true });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// ── GET /api/domains/:domain/health ───────────────────────────────────────────
// Aggregates SSL / DNS / Mail health / backups / disk / PHP / Apache errors
// for one domain. ~1s typical, dominated by the DNS resolve + disk du.
router.get('/:domain/health', async (req, res) => {
  try {
    const dh = require('../lib/domainhealth');
    res.json({ success: true, data: await dh.checkDomain(req.params.domain) });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ── GET /api/domains/:domain/diskusage ────────────────────────────────────────
router.get('/:domain/diskusage', (req, res) => {
  try {
    const { sanitizeDomain } = require('../lib/shell');
    sanitizeDomain(req.params.domain);
    const HIDDEN_SUFFIXES = ['-le-ssl', '000-default', 'default-ssl'];
    const vhosts = apache.listVhosts().filter(v =>
      !HIDDEN_SUFFIXES.some(h => v.domain.endsWith(h))
    );
    const vhost = vhosts.find(v => v.domain === req.params.domain);
    if (!vhost?.docRoot) return res.json({ success: false, error: 'Domain not found' });

    // du -sh on the docRoot; if it doesn't exist yet return 0
    const raw = execSync(
      `du -sb "${vhost.docRoot}" 2>/dev/null | cut -f1 || echo 0`,
      { encoding: 'utf8', timeout: 10000 }
    ).trim();
    const bytes = parseInt(raw, 10) || 0;

    // Human-readable
    function fmtBytes(b) {
      if (b < 1024) return b + ' B';
      if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
      if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
      return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB';
    }
    res.json({ success: true, data: { bytes, size: fmtBytes(bytes) } });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

module.exports = router;
