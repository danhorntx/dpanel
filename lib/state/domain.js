'use strict';
/**
 * lib/state/domain.js — Domain provisioning reconciler.
 *
 * Replaces the fire-and-forget workflow that lived inline in
 * routes/domains.js with a sequence of reconciler steps, each of which
 * knows how to:
 *   - check()  whether it's already in the desired state (idempotent)
 *   - apply()  the change AND return a rollback closure
 *
 * create(spec) runs the steps in order; on first failure it walks the
 * accumulated rollback closures in reverse so the caller never ends
 * up with a half-provisioned domain.
 *
 * Spec shape:
 *   {
 *     domain:    'example.com',          // required
 *     docRoot:   '/var/www/.../html',    // optional, defaults to /var/www/<domain>/public_html
 *     adminEmail: 'you@example.com',     // for Let's Encrypt; reconciler fetches from users.getAdminEmail() if absent
 *     withSftp:  true,                   // create SFTP deploy account
 *     withDns:   true,                   // create BIND zone or add A record to parent
 *     withSsl:   true,                   // certbot --apache for the main hostname
 *     mail:      {                       // optional mail bundle
 *       enabled:    true,
 *       autoconfig: true,                // autoconfig + autodiscover vhost + XML
 *       webmail:    true,                // webmail.<domain> proxy vhost + SSL
 *     }
 *   }
 *
 * Result shape:
 *   {
 *     success:  bool,
 *     domain:   string,
 *     steps:    [{ name, status: 'success'|'skipped'|'failed', duration_ms, error?, detail? }],
 *     rolledBack: string[]   // names of steps that were rolled back after a failure
 *     credentials: { ... }   // when withSftp=true and successful
 *   }
 */

const crypto       = require('crypto');
const { execSync } = require('child_process');
const apache       = require('../apache');
const access       = require('../access');
const ssl          = require('../ssl');
const dns          = require('../dns');
const mailsetup    = require('../mailsetup');
const mail         = require('../mail');
const dkim         = require('../dkim');
const users        = require('../users');
const dovecot      = require('../dovecot');
const mtasts       = require('../mtasts');

// ── Helpers ───────────────────────────────────────────────────────────────────

function generatePassword(len = 20) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from(crypto.randomBytes(len)).map(b => chars[b % chars.length]).join('');
}

function deriveUsername(domain) {
  const base = domain
    .replace(/\.[^.]+$/, '')
    .replace(/\./g, '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase()
    .slice(0, 24);
  return (base || 'site') + '_deploy';
}

function getServerIp() {
  try { return execSync("hostname -I | awk '{print $1}'", { encoding: 'utf8' }).trim(); }
  catch (_) { return dns.SERVER_IP; }
}

// For a subdomain like sub.example.com, walk up the labels and return the
// nearest ancestor that has a BIND zone we manage. Returns null at apex.
function findParentZone(domain) {
  const parts = domain.split('.');
  if (parts.length < 3) return null;
  for (let i = 1; i < parts.length - 1; i++) {
    const candidate = parts.slice(i).join('.');
    if (dns.zoneExists(candidate)) {
      return { parentDomain: candidate, subdomain: parts.slice(0, i).join('.') };
    }
  }
  return null;
}

// ── Step framework ────────────────────────────────────────────────────────────
// Each step:
//   name:    'apache-vhost'
//   needed:  (spec, ctx)  → bool   — should we run this step at all?
//   check:   (spec, ctx)  → bool   — is it already in desired state?
//   apply:   (spec, ctx)  → { rollback?, detail? }
//
// Rollbacks are best-effort: their failures are logged but do not throw.

async function _runStep(step, spec, ctx) {
  const t0 = Date.now();
  if (step.needed && !step.needed(spec, ctx)) {
    return { name: step.name, status: 'skipped', duration_ms: Date.now() - t0 };
  }
  try {
    if (step.check && await step.check(spec, ctx)) {
      return { name: step.name, status: 'skipped', duration_ms: Date.now() - t0, detail: 'already in desired state' };
    }
    const result = await step.apply(spec, ctx);
    if (result && typeof result.rollback === 'function') {
      ctx._rollbacks.push({ name: step.name, fn: result.rollback });
    }
    return { name: step.name, status: 'success', duration_ms: Date.now() - t0, detail: result?.detail };
  } catch (err) {
    return { name: step.name, status: 'failed', duration_ms: Date.now() - t0, error: err.message };
  }
}

// ── Step definitions ──────────────────────────────────────────────────────────

const STEPS = [
  // 1. Apache vhost — main website
  {
    name: 'apache-vhost',
    check: (spec) => {
      const fs   = require('fs');
      const path = require('path');
      return fs.existsSync(path.join('/etc/apache2/sites-available', `${spec.domain}.conf`));
    },
    apply: (spec, ctx) => {
      apache.createVhost({ domain: spec.domain, docRoot: spec.docRoot });
      ctx.docRoot = spec.docRoot || `/var/www/${spec.domain}/public_html`;
      return {
        rollback: async () => apache.deleteVhost(spec.domain),
        detail:   `vhost created at ${ctx.docRoot}`,
      };
    },
  },

  // 2. SFTP deploy account
  {
    name:   'sftp-account',
    needed: (spec) => spec.withSftp !== false,
    apply: (spec, ctx) => {
      const username = deriveUsername(spec.domain);
      const password = generatePassword(20);
      access.createAccount({
        domain:     spec.domain,
        username,
        password,
        docRoot:    ctx.docRoot,
        allowShell: false,
      });
      ctx.sftpUsername = username;
      ctx.sftpPassword = password;
      return {
        rollback: async () => access.deleteAccount(username),
        detail:   `username ${username}`,
      };
    },
  },

  // 3. DNS — apex zone OR subdomain A record in parent zone
  {
    name:   'dns',
    needed: (spec) => spec.withDns !== false,
    apply: (spec, ctx) => {
      const ip     = getServerIp() || dns.SERVER_IP;
      const parent = findParentZone(spec.domain);
      if (parent) {
        // Subdomain — inject A record into parent zone
        dns.addRecord(parent.parentDomain, { name: parent.subdomain, ttl: 14400, type: 'A', value: ip });
        ctx.dns = { action: 'record_added', parentDomain: parent.parentDomain, subdomain: parent.subdomain, ip };
        return {
          rollback: async () => dns.deleteRecord(parent.parentDomain, { name: parent.subdomain, type: 'A' }),
          detail:   `A record ${parent.subdomain}.${parent.parentDomain} → ${ip}`,
        };
      }
      // Apex — create full zone
      if (dns.zoneExists(spec.domain)) {
        ctx.dns = { action: 'zone_exists', domain: spec.domain };
        return { detail: 'zone already existed — no change' };
      }
      dns.createZone(spec.domain, ip);
      ctx.dns = { action: 'zone_created', domain: spec.domain, ip };
      return {
        rollback: async () => dns.deleteZone(spec.domain),
        detail:   `zone ${spec.domain} → ${ip}`,
      };
    },
  },

  // 4. Mail DNS — MX/SPF/DMARC/MTA-STS/TLS-RPT + DKIM key + DKIM TXT.
  //    setupMailDns auto-resolves whether to write into the domain's own zone
  //    (apex) or the parent zone with a prefix (subdomain). The DKIM record
  //    follows the same resolution via dns.addDkimRecord.
  {
    name:   'mail-dns',
    needed: (spec) => spec.mail?.enabled === true,
    apply: async (spec, ctx) => {
      const mailDnsApplied = dns.setupMailDns(spec.domain);
      let dkimGenerated = false;
      if (!dkim.hasDkim(spec.domain)) {
        await dkim.generateKey(spec.domain);
        dkimGenerated = true;
      }
      // (Re-)publish DKIM TXT — covers both fresh keys and stale records.
      if (mailDnsApplied) {
        const bare = dkim.getBareKey(spec.domain);
        if (bare) {
          try { dns.removeDkimRecord(spec.domain, 'mail'); } catch (_) {}
          dns.addDkimRecord(spec.domain, bare, 'mail');
        }
      }
      ctx.mailDns = { applied: mailDnsApplied, dkimGenerated };
      return {
        rollback: async () => {
          if (dkimGenerated) dkim.removeKey(spec.domain);
          // mail-dns records: for an APEX-with-its-own-zone, the dns step's
          // rollback (zone deletion) wipes them. For subdomains we'd otherwise
          // leak mail records into the parent — best-effort clean them up.
          try { dns.removeDkimRecord(spec.domain, 'mail'); } catch (_) {}
        },
        detail: `mail DNS applied=${mailDnsApplied}, DKIM generated=${dkimGenerated}`,
      };
    },
  },

  // 5. Mail account — first inbox (if specified)
  {
    name:   'mail-account',
    needed: (spec) => spec.mail?.enabled === true && spec.mail.firstAccount?.email && spec.mail.firstAccount?.password,
    apply: async (spec, ctx) => {
      const { email, password, quota } = spec.mail.firstAccount;
      await mail.addAccount(email, password, quota || '1G');
      ctx.firstMailAccount = email;
      return {
        rollback: async () => mail.deleteAccount(email),
        detail:   `mailbox ${email}`,
      };
    },
  },

  // 6. Mail autoconfig — autoconfig.<domain> + autodiscover.<domain> vhost + XML files + SSL
  // NOTE: setupMailAutoconfig() is itself idempotent and handles partial failure;
  // it always returns a result object rather than throwing.
  {
    name:   'mail-autoconfig',
    needed: (spec) => spec.mail?.enabled === true && spec.mail.autoconfig !== false,
    apply: async (spec, ctx) => {
      const result = await mailsetup.setupMailAutoconfig(spec.domain);
      ctx.mailAutoconfig = result;
      // Best-effort rollback: remove the autoconfig.<domain>.conf vhost. SSL cert is left in place.
      return {
        rollback: async () => {
          const fs       = require('fs');
          const path     = require('path');
          const confPath = path.join('/etc/apache2/sites-available', `autoconfig.${spec.domain}.conf`);
          if (fs.existsSync(confPath)) {
            try { execSync(`a2dissite autoconfig.${spec.domain}.conf`, { stdio: 'pipe' }); } catch (_) {}
            try { fs.unlinkSync(confPath); } catch (_) {}
            try { execSync('systemctl reload apache2', { stdio: 'pipe' }); } catch (_) {}
          }
        },
        detail: `autoconfig setup steps: ${Object.entries(result).filter(([k,v]) => v === true).map(([k]) => k).join(', ')}`,
      };
    },
  },

  // 7. Webmail vhost — webmail.<domain> proxy → panel
  {
    name:   'webmail-vhost',
    needed: (spec) => spec.mail?.enabled === true && spec.mail.webmail !== false,
    apply: (spec, ctx) => {
      const created = apache.createWebmailVhost(spec.domain);
      return {
        rollback: created ? async () => apache.deleteWebmailVhost(spec.domain) : null,
        detail:   created ? `webmail.${spec.domain} vhost created` : 'already existed',
      };
    },
  },

  // 8. SSL — main hostname via certbot --apache.
  // Sleeps briefly after DNS provisioning so BIND finishes reloading before
  // certbot queries the authoritative NS for the ACME challenge.
  {
    name:   'ssl-main',
    needed: (spec) => spec.withSsl !== false,
    apply: async (spec, ctx) => {
      const adminEmail = spec.adminEmail || (await users.getAdminEmail()) || `admin@${spec.domain}`;
      const dnsTouched = ctx.dns && ['record_added', 'zone_created'].includes(ctx.dns.action);
      if (dnsTouched) await new Promise(r => setTimeout(r, 3000));
      try {
        await ssl.autoSSL(spec.domain, adminEmail);
      } catch (firstErr) {
        // One retry with a longer delay — covers slow BIND propagation
        await new Promise(r => setTimeout(r, 10000));
        await ssl.autoSSL(spec.domain, adminEmail);
      }
      return {
        // SSL is non-destructive to revert: we just don't delete the cert on rollback
        // because the vhost will be torn down anyway.
        detail: `cert issued for ${spec.domain}`,
      };
    },
  },

  // 9. SSL — webmail subdomain (separate cert).
  //     Mail-subdomain A records were created by mail-dns one or two steps ago;
  //     give resolvers a moment to converge, then retry once on first failure.
  //     Non-fatal: webmail vhost still works on plain HTTP and is retryable.
  {
    name:   'ssl-webmail',
    needed: (spec) => spec.mail?.enabled === true && spec.mail.webmail !== false && spec.withSsl !== false,
    apply: async (spec, ctx) => {
      const adminEmail = spec.adminEmail || (await users.getAdminEmail()) || `admin@${spec.domain}`;
      const host = `webmail.${spec.domain}`;
      try {
        await ssl.autoSSL(host, adminEmail);
        ctx.webmailSsl = 'active';
        return { detail: `cert issued for ${host}` };
      } catch (firstErr) {
        await new Promise(r => setTimeout(r, 10000));
        try {
          await ssl.autoSSL(host, adminEmail);
          ctx.webmailSsl = 'active';
          return { detail: `cert issued for ${host} (retry)` };
        } catch (retryErr) {
          ctx.webmailSsl = 'failed';
          return { detail: `webmail SSL failed after retry (non-fatal): ${retryErr.message.slice(0, 200)}` };
        }
      }
    },
  },

  // 10. SSL — mail.<domain> for Dovecot/Postfix TLS.
  //     Uses certonly --webroot because there's no Apache vhost for mail.<domain> —
  //     mail traffic flows directly to Dovecot/Postfix, not through Apache.
  //     The default Apache vhost serves /var/www/html which catches unmatched
  //     hostnames, so the ACME challenge resolves via that path.
  //     Non-fatal: webmail/IMAP still work via env-var TLS fallback (lib/imap.js).
  {
    name:   'ssl-mail',
    needed: (spec) => spec.mail?.enabled === true && spec.withSsl !== false,
    apply: async (spec, ctx) => {
      const adminEmail = spec.adminEmail || (await users.getAdminEmail()) || `admin@${spec.domain}`;
      const host = `mail.${spec.domain}`;
      try {
        await ssl.issueWebrootCert(host, adminEmail);
        ctx.mailSsl = 'active';
        return { detail: `cert issued for ${host}` };
      } catch (firstErr) {
        await new Promise(r => setTimeout(r, 10000));
        try {
          await ssl.issueWebrootCert(host, adminEmail);
          ctx.mailSsl = 'active';
          return { detail: `cert issued for ${host} (retry)` };
        } catch (retryErr) {
          ctx.mailSsl = 'failed';
          return { detail: `mail SSL failed after retry (non-fatal): ${retryErr.message.slice(0, 200)}` };
        }
      }
    },
  },

  // 11. Dovecot SNI — register mail.<domain>'s cert so IMAP clients connecting
  //     with SNI = mail.<domain> get the matching cert. Only meaningful if
  //     ssl-mail issued a cert — otherwise registerLocalName() would throw.
  {
    name:   'dovecot-sni',
    needed: (spec, ctx) => spec.mail?.enabled === true && ctx.mailSsl === 'active',
    apply: async (spec) => {
      dovecot.registerLocalName(spec.domain);
      dovecot.reload();
      return {
        rollback: async () => {
          dovecot.unregisterLocalName(spec.domain);
          try { dovecot.reload(); } catch (_) { /* don't escalate rollback failures */ }
        },
        detail: `Dovecot SNI registered for mail.${spec.domain}`,
      };
    },
  },

  // 12. MTA-STS policy — writes /var/www/mta-sts.<domain>/.well-known/mta-sts.txt
  //     + an Apache vhost. Receivers use this for TLS enforcement. Non-fatal
  //     if any sub-step (vhost, SSL) fails; the DNS record was already
  //     published by mail-dns so receivers see "STSv1 announced" either way.
  {
    name:   'mta-sts',
    needed: (spec) => spec.mail?.enabled === true,
    apply: async (spec, ctx) => {
      const result = mtasts.setupPolicy(spec.domain, { mode: 'testing' });
      ctx.mtaSts = result;
      return {
        rollback: async () => { try { mtasts.teardownPolicy(spec.domain); } catch (_) {} },
        detail:   `Policy published (id=${result.id}, mode=testing)`,
      };
    },
  },

  // 13. SSL for mta-sts.<domain> — the policy MUST be served over HTTPS with
  //     a valid cert (RFC 8461). Non-fatal: if cert issuance fails, the DNS
  //     record still advertises STSv1 but the policy URL won't validate
  //     until the operator retries. mail-health will catch and surface this.
  {
    name:   'ssl-mta-sts',
    needed: (spec) => spec.mail?.enabled === true && spec.withSsl !== false,
    apply: async (spec, ctx) => {
      const adminEmail = spec.adminEmail || (await users.getAdminEmail()) || `admin@${spec.domain}`;
      const host = `mta-sts.${spec.domain}`;
      try {
        await ssl.autoSSL(host, adminEmail);
        ctx.mtaStsSsl = 'active';
        return { detail: `cert issued for ${host}` };
      } catch (firstErr) {
        await new Promise(r => setTimeout(r, 10000));
        try {
          await ssl.autoSSL(host, adminEmail);
          ctx.mtaStsSsl = 'active';
          return { detail: `cert issued for ${host} (retry)` };
        } catch (retryErr) {
          ctx.mtaStsSsl = 'failed';
          return { detail: `mta-sts SSL failed after retry (non-fatal): ${retryErr.message.slice(0, 200)}` };
        }
      }
    },
  },
];

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Provision a domain end-to-end with atomic rollback on failure.
 *
 * The reconciler runs each step in order. On the first failure, every
 * step that previously succeeded has its rollback invoked in reverse.
 * The result tells the caller exactly which steps ran, which were
 * skipped (already in desired state), and which (if any) failed +
 * triggered the cascade.
 *
 * @param {object} spec   — see file header for full shape
 * @returns {Promise<object>}
 */
async function create(spec) {
  if (!spec || !spec.domain) throw new Error('spec.domain is required');

  const ctx = { _rollbacks: [] };
  const steps = [];

  for (const step of STEPS) {
    const result = await _runStep(step, spec, ctx);
    steps.push(result);

    if (result.status === 'failed') {
      const rolledBack = [];
      for (const rb of ctx._rollbacks.reverse()) {
        try { await rb.fn(); rolledBack.push(rb.name); }
        catch (rbErr) {
          console.error(`[state/domain] Rollback for ${rb.name} failed:`, rbErr.message);
        }
      }
      return {
        success: false,
        domain:  spec.domain,
        steps,
        rolledBack,
        error:   `Step '${result.name}' failed: ${result.error}`,
      };
    }
  }

  return {
    success: true,
    domain:  spec.domain,
    steps,
    rolledBack: [],
    credentials: {
      domain:   spec.domain,
      host:     getServerIp() || dns.SERVER_IP,
      port:     22,
      docRoot:  ctx.docRoot,
      username: ctx.sftpUsername || null,
      password: ctx.sftpPassword || null,
      sslStatus:    steps.find(s => s.name === 'ssl-main')?.status === 'success' ? 'active' : 'pending',
      webmailSsl:   ctx.webmailSsl,
      dns:          ctx.dns,
      mailDns:      ctx.mailDns,
      firstMailAccount: ctx.firstMailAccount || null,
    },
  };
}

/**
 * Tear down a domain. Best-effort: each teardown step independently
 * tries to clean up its piece, and a step's failure does NOT abort
 * later ones — we want to delete as much as we can.
 *
 * @param {string} domain
 * @returns {Promise<object>}  { success, domain, steps: [{name, status, error?}] }
 */
async function destroy(domain) {
  if (!domain) throw new Error('domain is required');
  const steps = [];

  const teardown = [
    { name: 'dovecot-sni',       fn: () => {
        dovecot.unregisterLocalName(domain);
        try { dovecot.reload(); } catch (_) { /* config-test failures shouldn't block destroy */ }
      }},
    { name: 'mta-sts',           fn: () => mtasts.teardownPolicy(domain) },
    { name: 'webmail-vhost',     fn: () => apache.deleteWebmailVhost(domain) },
    { name: 'autoconfig-vhost',  fn: () => apache.deleteAutoconfigVhost(domain) },
    { name: 'apache-vhost',      fn: () => apache.deleteVhost(domain) },
    { name: 'ssl-certs',         fn: () => {
        // Best-effort: delete Let's Encrypt certs for the domain + its mail subdomains.
        // certbot delete may fail (no such cert) — we ignore those.
        const candidates = [domain, `webmail.${domain}`, `autoconfig.${domain}`, `mail.${domain}`, `mta-sts.${domain}`];
        for (const c of candidates) {
          try { execSync(`certbot delete --cert-name ${c} --non-interactive`, { stdio: 'pipe', timeout: 10000 }); } catch (_) {}
        }
      }},
    { name: 'dkim',              fn: () => { if (dkim.hasDkim(domain)) dkim.removeKey(domain); } },
    { name: 'dns',               fn: () => {
        const parent = findParentZone(domain);
        if (parent) dns.deleteRecord(parent.parentDomain, { name: parent.subdomain, type: 'A' });
        // Apex zones are intentionally left intact — operator may have
        // custom records and can delete via DNS Manager if desired.
      }},
    { name: 'sftp-account',      fn: () => {
        const accounts = access.readAccounts().filter(a => a.domain === domain);
        for (const a of accounts) access.deleteAccount(a.username);
      }},
  ];

  for (const t of teardown) {
    const t0 = Date.now();
    try {
      await t.fn();
      steps.push({ name: t.name, status: 'success', duration_ms: Date.now() - t0 });
    } catch (err) {
      steps.push({ name: t.name, status: 'failed', duration_ms: Date.now() - t0, error: err.message });
    }
  }

  return { success: steps.every(s => s.status === 'success'), domain, steps };
}

module.exports = { create, destroy };
