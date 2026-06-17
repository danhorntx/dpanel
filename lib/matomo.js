'use strict';
/**
 * lib/matomo.js — high-level Matomo operations DPanel calls into.
 *
 * Wraps the in-container helper (matomo-cli.php) and the snippet injector
 * (inject-matomo-snippet.py) so the reconciler + routes don't have to
 * shell out to docker exec by hand. Idempotent across the board.
 *
 * Layered on the same install pattern as lib/postfix.js / lib/dovecot.js:
 * functions read/modify the host's Apache vhost dir + Matomo's
 * config.ini.php + the matomo containers. Every operation eventually goes
 * through the bundled matomo-cli.php via Access::doAsSuperUser() — no
 * HTTP token_auth required, no rate-limit considerations.
 */

const fs   = require('fs');
const path = require('path');
const { execFileSync, execSync } = require('child_process');
const crypto = require('crypto');
const { sanitizeDomain, logAction } = require('./shell');

const MATOMO_ROOT     = '/opt/matomo';
const MATOMO_HOST     = 'analytics.danhorntx.com';
const CONFIG_INI      = '/opt/matomo/app/config/config.ini.php';
const APACHE_AVAILABLE = '/etc/apache2/sites-available';
const INJECT_SCRIPT   = '/opt/matomo/inject-matomo-snippet.py';

// ── matomo-cli.php wrapper ─────────────────────────────────────────────────
// Each call: ~150ms (docker exec + bootstrap). Synchronous because every
// caller is already in an async reconciler step that awaits the apply().
function cli(...args) {
  const stdout = execFileSync(
    'docker', ['exec', 'matomo-app', 'php', '/var/www/html/matomo-cli.php', ...args],
    { encoding: 'utf8', timeout: 10000 }
  );
  try { return JSON.parse(stdout); }
  catch { throw new Error(`matomo-cli unexpected output: ${stdout.slice(0, 200)}`); }
}

// ── Sites ──────────────────────────────────────────────────────────────────
function listSites() {
  return cli('list-sites');
}

function findSiteByUrl(url) {
  const u = url.replace(/\/$/, '');
  return listSites().find(s => (s.main_url || '').replace(/\/$/, '') === u) || null;
}

function addSite(domain, { ecommerce = 0 } = {}) {
  sanitizeDomain(domain);
  const url = `https://${domain}`;
  const existing = findSiteByUrl(url);
  if (existing) return { idsite: existing.idsite, alreadyExisted: true };
  const r = cli('add-site', domain, url, String(ecommerce));
  logAction('matomo:add-site', domain, `idsite=${r.idsite}`);
  return { idsite: r.idsite, alreadyExisted: false };
}

function deleteSite(idsite) {
  if (!idsite) return;
  // Matomo refuses to delete the last remaining site. Tolerate that — leaves
  // the site behind but doesn't break the teardown.
  try { cli('delete-site', String(idsite)); }
  catch (err) {
    if (/SitesManager_ExceptionDeleteSite/.test(err.message)) {
      logAction('matomo:delete-site', String(idsite), 'skipped (last site)');
      return;
    }
    throw err;
  }
  logAction('matomo:delete-site', String(idsite), 'ok');
}

// ── Users ──────────────────────────────────────────────────────────────────
function generatePassword(len = 20) {
  return crypto.randomBytes(len).toString('base64').replace(/[+/=]/g, '').slice(0, len);
}

function listUsers() {
  return cli('list-users');
}

function userExists(login) {
  return listUsers().some(u => u.login === login);
}

/**
 * Create a new Matomo user. Idempotent — if login already exists, returns
 * { alreadyExisted: true } with the existing user's email. No password
 * change in that case; caller decides whether to rotate.
 */
function addUser({ login, password, email }) {
  if (!login || !email) throw new Error('addUser requires login + email');
  const existing = listUsers().find(u => u.login === login);
  if (existing) {
    return { login, email: existing.email, password: null, alreadyExisted: true };
  }
  const pw = password || generatePassword(20);
  cli('add-user', login, pw, email);
  logAction('matomo:add-user', login, email);
  return { login, email, password: pw, alreadyExisted: false };
}

function grantSiteAccess({ login, access = 'view', idsite }) {
  if (!login || !idsite) throw new Error('grantSiteAccess requires login + idsite');
  cli('grant-site-access', login, access, String(idsite));
  logAction('matomo:grant-access', login, `${access}@${idsite}`);
}

function deleteUser(login) {
  if (!login) return;
  try { cli('delete-user', login); }
  catch (err) {
    if (/User .* does not exist/i.test(err.message)) return;
    throw err;
  }
  logAction('matomo:delete-user', login, 'ok');
}

// ── Trusted hosts (config.ini.php) ────────────────────────────────────────
function listTrustedHosts() {
  if (!fs.existsSync(CONFIG_INI)) return [];
  const cf = fs.readFileSync(CONFIG_INI, 'utf8');
  return [...cf.matchAll(/^\s*trusted_hosts\[\]\s*=\s*"([^"]+)"/gm)].map(m => m[1]);
}

/**
 * Add a hostname to Matomo's trusted_hosts allowlist. Idempotent. Matomo
 * refuses to serve on a hostname not in this list.
 */
function addTrustedHost(host) {
  if (!host) return;
  const hosts = listTrustedHosts();
  if (hosts.includes(host)) return false;
  if (!fs.existsSync(CONFIG_INI)) throw new Error(`Matomo config not found: ${CONFIG_INI}`);
  let cf = fs.readFileSync(CONFIG_INI, 'utf8');
  // Insert directly after the last existing trusted_hosts[] line so the
  // ordering stays grouped. If there's none yet, append under [General].
  if (/^\s*trusted_hosts\[\]\s*=/m.test(cf)) {
    const lines = cf.split('\n');
    let lastIdx = -1;
    lines.forEach((l, i) => { if (/^\s*trusted_hosts\[\]\s*=/.test(l)) lastIdx = i; });
    lines.splice(lastIdx + 1, 0, `trusted_hosts[] = "${host}"`);
    cf = lines.join('\n');
  } else if (/^\[General\]/m.test(cf)) {
    cf = cf.replace(/^\[General\]\s*\n/m, `[General]\ntrusted_hosts[] = "${host}"\n`);
  } else {
    cf += `\n[General]\ntrusted_hosts[] = "${host}"\n`;
  }
  fs.writeFileSync(CONFIG_INI, cf);
  // Inside container, Matomo caches config; cache clear picks up the new host.
  try { execSync('docker exec matomo-app php /var/www/html/console cache:clear', { stdio: 'pipe' }); } catch (_) {}
  logAction('matomo:trusted-host', host, 'added');
  return true;
}

function removeTrustedHost(host) {
  if (!host || !fs.existsSync(CONFIG_INI)) return;
  let cf = fs.readFileSync(CONFIG_INI, 'utf8');
  const before = cf;
  cf = cf.replace(new RegExp(`^\\s*trusted_hosts\\[\\]\\s*=\\s*"${host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*\n`, 'm'), '');
  if (cf === before) return;
  fs.writeFileSync(CONFIG_INI, cf);
  try { execSync('docker exec matomo-app php /var/www/html/console cache:clear', { stdio: 'pipe' }); } catch (_) {}
  logAction('matomo:trusted-host', host, 'removed');
}

// ── Snippet injection via Apache mod_substitute ──────────────────────────
// Wraps the standalone python injector so the reconciler can invoke it.
// Snippet lives in the SSL vhost (-le-ssl.conf). Idempotent.
function injectSnippet(domain, idsite) {
  sanitizeDomain(domain);
  if (!idsite) throw new Error('injectSnippet requires idsite');
  if (!fs.existsSync(INJECT_SCRIPT)) {
    throw new Error(`Snippet injector not present at ${INJECT_SCRIPT}. Deploy matomo/inject-matomo-snippet.py first.`);
  }
  execFileSync('python3', [INJECT_SCRIPT, domain, String(idsite)], { stdio: 'pipe' });
  // Sanity: configtest before reload — broken vhost would kill all Apache.
  execSync('apache2ctl configtest', { stdio: 'pipe' });
  execSync('systemctl reload apache2');
  logAction('matomo:snippet', domain, `siteId=${idsite}`);
}

/**
 * Strip the matomo-canary block from a domain's SSL vhost. Idempotent.
 */
function removeSnippet(domain) {
  sanitizeDomain(domain);
  const vhost = path.join(APACHE_AVAILABLE, `${domain}-le-ssl.conf`);
  if (!fs.existsSync(vhost)) return;
  const before = fs.readFileSync(vhost, 'utf8');
  // Strip the 4-line matomo-canary block matching the injector's emit format.
  const after = before.replace(
    /\n\s*# matomo-canary[^\n]*\n\s*# every HTML response[^\n]*\n\s*AddOutputFilterByType SUBSTITUTE text\/html\n\s*Substitute "[^"]+"\n/m,
    '\n'
  );
  if (after === before) return;
  fs.writeFileSync(vhost, after);
  try {
    execSync('apache2ctl configtest', { stdio: 'pipe' });
    execSync('systemctl reload apache2');
  } catch (_) { /* leave the file changed; manual fix possible */ }
  logAction('matomo:snippet', domain, 'removed');
}

// ── Branded login vhost (matomo.<domain>) ─────────────────────────────────
// Identical pattern to analytics.danhorntx.com: port-80 proxy + certbot
// --apache injects the SSL vhost variant. Snippet path obfuscation is
// already handled centrally on the analytics.* vhost — clients hitting the
// branded subdomain will still use the obfuscated /cdn/* paths for tracking.
function createTenantVhost(domain) {
  sanitizeDomain(domain);
  const tenantHost = `matomo.${domain}`;
  const confPath = path.join(APACHE_AVAILABLE, `${tenantHost}.conf`);
  if (fs.existsSync(confPath)) return false;
  const body = `<VirtualHost *:80>
    ServerName ${tenantHost}

    Alias /.well-known/acme-challenge/ /var/www/html/.well-known/acme-challenge/
    <Directory /var/www/html/.well-known/acme-challenge/>
        Options None
        AllowOverride None
        Require all granted
    </Directory>

    ProxyPreserveHost On
    ProxyPass        /.well-known/acme-challenge/ !
    ProxyPass        / http://127.0.0.1:8088/
    ProxyPassReverse / http://127.0.0.1:8088/

    ErrorLog  \${APACHE_LOG_DIR}/${tenantHost}_error.log
    CustomLog \${APACHE_LOG_DIR}/${tenantHost}_access.log combined
</VirtualHost>
`;
  fs.writeFileSync(confPath, body);
  execSync(`a2ensite ${tenantHost}.conf`, { stdio: 'pipe' });
  execSync('apache2ctl configtest', { stdio: 'pipe' });
  execSync('systemctl reload apache2');
  logAction('matomo:tenant-vhost', tenantHost, 'created');
  return true;
}

function deleteTenantVhost(domain) {
  sanitizeDomain(domain);
  const tenantHost = `matomo.${domain}`;
  for (const file of [`${tenantHost}.conf`, `${tenantHost}-le-ssl.conf`]) {
    const p = path.join(APACHE_AVAILABLE, file);
    if (fs.existsSync(p)) {
      try { execSync(`a2dissite ${file}`, { stdio: 'pipe' }); } catch (_) {}
      try { fs.unlinkSync(p); } catch (_) {}
    }
  }
  try {
    execSync('apache2ctl configtest', { stdio: 'pipe' });
    execSync('systemctl reload apache2');
  } catch (_) {}
  logAction('matomo:tenant-vhost', tenantHost, 'deleted');
}

// ── Public surface ─────────────────────────────────────────────────────────
module.exports = {
  MATOMO_HOST,
  // Sites
  listSites, findSiteByUrl, addSite, deleteSite,
  // Users
  listUsers, userExists, addUser, grantSiteAccess, deleteUser, generatePassword,
  // Trusted hosts
  listTrustedHosts, addTrustedHost, removeTrustedHost,
  // Snippet
  injectSnippet, removeSnippet,
  // Tenant vhost
  createTenantVhost, deleteTenantVhost,
};
