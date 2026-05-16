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
//
// Two body shapes accepted:
//
//   1. SSH-first (new, preferred):
//      {
//        domain, adminEmail?,
//        sshKeys: [{ label, publicKey, source? }],   // ≥1 unless allowFtp+password
//        allowShell?:  bool   (default false)
//        allowFtp?:    bool   (default false — opt-in password fallback)
//        password?:    string  (required if allowFtp)
//        placeholder?: bool   (write Coming Soon static index.html)
//        setupMailDns?:bool   (mail stack — same flag as before)
//      }
//
//   2. Legacy (kept for the old modal + integrations):
//      { domain, docRoot?, setupMailDns? }   — generates a password-only
//      deploy account via the original reconciler step.
//
// The SSH-first shape pre-provisions the deploy user (so the docroot lives
// inside the user's chroot jail at /home/<user>/public_html) and then runs
// the reconciler with withSftp=false. If the reconciler fails afterwards
// we tear the user back down so the caller sees a clean rollback.
router.post('/', async (req, res) => {
  // Creating a new domain is a server-wide action — admin only.
  if (req.session?.role && req.session.role !== 'admin') {
    return res.status(403).json({ success: false, error: 'Admin role required to add domains.' });
  }
  const {
    domain, docRoot, setupMailDns, adminEmail,
    sshKeys, allowShell, allowFtp, password, placeholder,
  } = req.body || {};
  if (!domain) return res.json({ success: false, error: 'Domain name is required.' });

  const sshFirst = Array.isArray(sshKeys) && sshKeys.length > 0 || !!allowFtp;
  let preProvision = null;
  let resolvedDocRoot = docRoot;

  try {
    if (sshFirst) {
      const access = require('../lib/access');
      preProvision = access.provisionDomainUser({
        domain,
        sshKeys:    sshKeys || [],
        allowShell: !!allowShell,
        allowFtp:   !!allowFtp,
        password,
        createdBy:  req.session?.userId,
      });
      resolvedDocRoot = preProvision.docRoot;
    }

    const spec = {
      domain,
      docRoot:    resolvedDocRoot,
      adminEmail,
      withSftp:   !sshFirst,              // legacy path still uses step 2
      withDns:    true,
      withSsl:    true,
      mail:       setupMailDns ? { enabled: true, autoconfig: true, webmail: true } : { enabled: false },
    };

    const result = await domainState.create(spec);

    if (!result.success) {
      // Roll back the SSH-first deploy user we created outside the reconciler.
      if (preProvision) {
        try { require('../lib/access').deleteAccount(preProvision.username); } catch (_) {}
      }
      return res.json({
        success:    false,
        error:      result.error,
        steps:      result.steps,
        rolledBack: [...result.rolledBack, ...(preProvision ? ['ssh-deploy-user'] : [])],
      });
    }

    // Coming Soon placeholder — best-effort, non-fatal.
    if (placeholder) {
      try { writePlaceholder(resolvedDocRoot, domain); }
      catch (err) { result.credentials.placeholderError = err.message; }
    }

    // Merge SSH-first provisioning detail into credentials.
    if (preProvision) {
      result.credentials.username  = preProvision.username;
      result.credentials.docRoot   = preProvision.docRoot;
      result.credentials.chrootDir = preProvision.chrootDir;
      result.credentials.keys      = preProvision.keys;
      result.credentials.ftpEnabled = !!allowFtp;
      // The auto-generated SFTP password from the legacy step is NULL in
      // SSH-first mode — surface this explicitly so the UI shows "key-only".
      result.credentials.password  = allowFtp ? password : null;
      result.credentials.authMode  = 'ssh-first';
    } else {
      result.credentials.authMode  = 'legacy';
    }

    res.json({
      success:     true,
      credentials: result.credentials,
      steps:       result.steps,
    });
  } catch (err) {
    if (preProvision) {
      try { require('../lib/access').deleteAccount(preProvision.username); } catch (_) {}
    }
    res.json({ success: false, error: err.message });
  }
});

// Write a minimal Coming Soon page to a freshly-provisioned docroot.
// The file is intentionally small + self-contained so it survives a future
// Apache config tweak without depending on shared assets.
function writePlaceholder(docRoot, domain) {
  if (!docRoot || !fs.existsSync(docRoot)) return;
  const html = `<!doctype html>
<!-- DPanel-Placeholder -->
<html lang="en"><head><meta charset="utf-8">
<title>${domain.replace(/[<>&]/g, '')} — Coming Soon</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  html,body{height:100%;margin:0;font-family:system-ui,sans-serif;background:#0f0f17;color:#e4e4e7}
  .wrap{min-height:100%;display:flex;align-items:center;justify-content:center;text-align:center;padding:2rem}
  h1{font-size:2rem;font-weight:600;margin:0 0 .5rem;letter-spacing:-.02em}
  p{margin:0;color:#a1a1aa}
</style></head>
<body><div class="wrap"><div>
  <h1>Coming soon</h1>
  <p>${domain.replace(/[<>&]/g, '')} is being prepared.</p>
</div></div></body></html>
`;
  fs.writeFileSync(path.join(docRoot, 'index.html'), html);
  try { execSync(`chmod 664 ${docRoot}/index.html`); } catch (_) {}
}

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
