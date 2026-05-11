'use strict';
const fs = require('fs');
const path = require('path');
const { run, sanitizeDomain, sanitizePath } = require('./shell');

const SITES_AVAILABLE = '/etc/apache2/sites-available';
const SITES_ENABLED   = '/etc/apache2/sites-enabled';
const WEBROOT_BASE    = '/var/www';

/**
 * Scan every .conf in sites-available and return a map of
 *   hostname (lowercased) → filename
 * built from each vhost's ServerName + ServerAlias.
 *
 * Used by assertHostnamesAvailable() to catch the historical bug where the
 * autoconfig vhost claimed webmail.<domain> as a ServerAlias and stole
 * webmail traffic from its own vhost.
 */
function _collectClaimedHostnames() {
  const claimed = new Map(); // host → filename that claimed it
  if (!fs.existsSync(SITES_AVAILABLE)) return claimed;
  for (const file of fs.readdirSync(SITES_AVAILABLE).filter(f => f.endsWith('.conf'))) {
    const text = fs.readFileSync(path.join(SITES_AVAILABLE, file), 'utf8');
    for (const m of text.matchAll(/^\s*ServerName\s+(\S+)/gim))   claimed.set(m[1].toLowerCase(), file);
    for (const m of text.matchAll(/^\s*ServerAlias\s+(.+)$/gim)) {
      for (const host of m[1].trim().split(/\s+/)) claimed.set(host.toLowerCase(), file);
    }
  }
  return claimed;
}

/**
 * Throws if any of `hostnames` is already claimed by a vhost file other
 * than `excludeFile` (which is the file the caller is about to write).
 *
 * `excludeFile` should be the basename only, e.g. "webmail.example.com.conf".
 * `-le-ssl` twin files are tolerated (they're the SSL companion to a vhost
 * we already accepted, written by certbot).
 */
function assertHostnamesAvailable(hostnames, excludeFile) {
  const claimed = _collectClaimedHostnames();
  for (const raw of hostnames) {
    const host = raw.toLowerCase();
    const owner = claimed.get(host);
    if (!owner) continue;
    if (owner === excludeFile) continue;
    if (owner.replace(/-le-ssl\.conf$/, '.conf') === excludeFile) continue;
    throw new Error(
      `Hostname collision: '${host}' is already claimed by ${owner}. ` +
      `Refusing to create ${excludeFile} until the conflict is resolved.`
    );
  }
}

function listVhosts() {
  const files = fs.readdirSync(SITES_AVAILABLE).filter(f => f.endsWith('.conf'));
  return files.map(file => {
    const confPath = path.join(SITES_AVAILABLE, file);
    const content = fs.readFileSync(confPath, 'utf8');
    const domain = file.replace('.conf', '');
    const docRootMatch = content.match(/DocumentRoot\s+(.+)/);
    const docRoot = docRootMatch ? docRootMatch[1].trim() : '';
    const sslMatch = content.match(/SSLEngine\s+on/i);
    const enabledPath = path.join(SITES_ENABLED, file);
    const enabled = fs.existsSync(enabledPath);
    const certPath = `/etc/letsencrypt/live/${domain}/fullchain.pem`;
    const hasSSL = sslMatch !== null || fs.existsSync(certPath);
    return { domain, docRoot, ssl: hasSSL, enabled, file };
  });
}

function getVhostConfig(domain) {
  sanitizeDomain(domain);
  const confPath = path.join(SITES_AVAILABLE, `${domain}.conf`);
  if (!fs.existsSync(confPath)) throw new Error(`Config not found: ${domain}`);
  return fs.readFileSync(confPath, 'utf8');
}

function createVhost({ domain, docRoot, php }) {
  sanitizeDomain(domain);
  const root = docRoot ? sanitizePath(docRoot) : `${WEBROOT_BASE}/${domain}/public_html`;
  const confFile = `${domain}.conf`;
  const confPath = path.join(SITES_AVAILABLE, confFile);
  if (fs.existsSync(confPath)) throw new Error(`Vhost already exists: ${domain}`);

  // Guard: refuse to write if another vhost already claims these hostnames
  assertHostnamesAvailable([domain, `www.${domain}`], confFile);

  // Create document root if needed
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });

  const conf = `<VirtualHost *:80>
    ServerName ${domain}
    ServerAlias www.${domain}
    DocumentRoot ${root}
    ErrorLog \${APACHE_LOG_DIR}/${domain}_error.log
    CustomLog \${APACHE_LOG_DIR}/${domain}_access.log combined
    <Directory ${root}>
        Options -Indexes +FollowSymLinks
        AllowOverride All
        Require all granted
    </Directory>
</VirtualHost>
`;
  fs.writeFileSync(confPath, conf);
  run(`a2ensite ${domain}.conf`, 'apache:enable-site', domain);
  run('apache2ctl configtest', 'apache:configtest', domain);
  run('systemctl reload apache2', 'apache:reload', domain);
}

function enableVhost(domain) {
  sanitizeDomain(domain);
  run(`a2ensite ${domain}.conf`, 'apache:enable-site', domain);
  run('systemctl reload apache2', 'apache:reload', domain);
}

function disableVhost(domain) {
  sanitizeDomain(domain);
  run(`a2dissite ${domain}.conf`, 'apache:disable-site', domain);
  run('systemctl reload apache2', 'apache:reload', domain);
}

function deleteVhost(domain) {
  sanitizeDomain(domain);
  const confPath = path.join(SITES_AVAILABLE, `${domain}.conf`);
  const sslPath  = path.join(SITES_AVAILABLE, `${domain}-le-ssl.conf`);
  try { run(`a2dissite ${domain}.conf`,        'apache:disable-site',     domain); } catch (_) {}
  try { run(`a2dissite ${domain}-le-ssl.conf`, 'apache:disable-site-ssl', domain); } catch (_) {}
  if (fs.existsSync(confPath)) fs.unlinkSync(confPath);
  if (fs.existsSync(sslPath))  fs.unlinkSync(sslPath);
  run('systemctl reload apache2', 'apache:reload', domain);
}

/**
 * Tear down the autoconfig.<domain> vhost created by lib/mailsetup.js.
 * Idempotent — safe to call on domains that never had one.
 */
function deleteAutoconfigVhost(domain) {
  sanitizeDomain(domain);
  const subdomain = `autoconfig.${domain}`;
  const confPath  = path.join(SITES_AVAILABLE, `${subdomain}.conf`);
  const sslPath   = path.join(SITES_AVAILABLE, `${subdomain}-le-ssl.conf`);
  try { run(`a2dissite ${subdomain}.conf`,        'apache:disable-autoconfig',     subdomain); } catch (_) {}
  try { run(`a2dissite ${subdomain}-le-ssl.conf`, 'apache:disable-autoconfig-ssl', subdomain); } catch (_) {}
  if (fs.existsSync(confPath)) fs.unlinkSync(confPath);
  if (fs.existsSync(sslPath))  fs.unlinkSync(sslPath);
  try { run('systemctl reload apache2', 'apache:reload', subdomain); } catch (_) {}
}

function updateVhost(domain, content) {
  sanitizeDomain(domain);
  const confPath = path.join(SITES_AVAILABLE, `${domain}.conf`);
  fs.writeFileSync(confPath, content);
  run('apache2ctl configtest', 'apache:configtest', domain);
  run('systemctl reload apache2', 'apache:reload', domain);
}

// ─── Webmail vhost ───────────────────────────────────────────────────────────
// webmail.<domain> serves the DPanel webmail UI. By default it serves the
// new DPanel webmail SPA (vendored from duperhuman) with /api/* proxied to
// the dpanel-webmail service on 127.0.0.1:3501. If the client carries a
// `webmail_mode=classic` cookie, every request is rewritten to the legacy
// DPanel webmail at 127.0.0.1:8080 instead — letting individual users
// opt back to the old UI without affecting anyone else.

const DPANEL_WEBMAIL_ROOT = '/opt/dpanel/webmail/client/dist';
const DPANEL_WEBMAIL_PORT = 3501;

function webmailVhostBody(subdomain) {
  return `    ServerName ${subdomain}

    # ACME http-01 challenges MUST be served locally so certbot can renew.
    Alias /.well-known/acme-challenge/ /var/www/html/.well-known/acme-challenge/
    ProxyPass /.well-known/acme-challenge/ !
    <Directory /var/www/html/.well-known/acme-challenge/>
        Options None
        AllowOverride None
        Require all granted
    </Directory>

    # ── Classic-mode opt-out ────────────────────────────────────────────────
    # Users who prefer the legacy webmail set this cookie via the new UI's
    # "Switch to classic" button. Apache then proxies the entire request to
    # the legacy DPanel server, bypassing the new SPA + API server entirely.
    SSLProxyEngine On
    SSLProxyVerify none
    SSLProxyCheckPeerCN off
    SSLProxyCheckPeerName off
    ProxyPreserveHost On
    RewriteEngine On
    RewriteCond %{HTTP_COOKIE} (^|;\\s*)webmail_mode=classic
    RewriteCond %{REQUEST_URI} !^/\\.well-known/acme-challenge/
    RewriteRule ^/?(.*)$ https://127.0.0.1:8080/$1 [P,L]

    # ── Default: new DPanel webmail (vendored duperhuman) ──────────────────
    # /api/* hits the dpanel-webmail Fastify server on a dedicated port.
    ProxyPass /api/ http://127.0.0.1:${DPANEL_WEBMAIL_PORT}/api/
    ProxyPassReverse /api/ http://127.0.0.1:${DPANEL_WEBMAIL_PORT}/api/

    # Everything else is served statically from the client build, with an
    # SPA fallback so /any/path returns index.html for client-side routing.
    DocumentRoot ${DPANEL_WEBMAIL_ROOT}
    <Directory ${DPANEL_WEBMAIL_ROOT}>
        Options -Indexes
        AllowOverride None
        Require all granted
        FallbackResource /index.html
    </Directory>

    ErrorLog \${APACHE_LOG_DIR}/${subdomain}_error.log
    CustomLog \${APACHE_LOG_DIR}/${subdomain}_access.log combined`;
}

/**
 * Create a webmail vhost for webmail.<domain>. Idempotent — does nothing
 * if the :80 vhost already exists. New installs hit this path via the
 * domain reconciler; existing installs use regenerateWebmailVhost() to
 * upgrade in place.
 */
function createWebmailVhost(domain) {
  sanitizeDomain(domain);
  const subdomain = `webmail.${domain}`;
  const confFile  = `${subdomain}.conf`;
  const confPath  = path.join(SITES_AVAILABLE, confFile);
  if (fs.existsSync(confPath)) return false; // already set up

  // Guard: refuse to write if another vhost (historically the autoconfig one)
  // already claims webmail.<domain> as a ServerName or ServerAlias.
  assertHostnamesAvailable([subdomain], confFile);

  const conf = `<VirtualHost *:80>
${webmailVhostBody(subdomain)}
</VirtualHost>
`;

  fs.writeFileSync(confPath, conf);
  run(`a2ensite ${subdomain}.conf`, 'apache:enable-webmail', subdomain);
  run('apache2ctl configtest', 'apache:configtest-webmail', subdomain);
  run('systemctl reload apache2', 'apache:reload', subdomain);
  return true;
}

/**
 * Rewrite an existing webmail vhost (both :80 and any certbot-generated :443
 * conf) to the new template. Used by the one-shot migration on upgrade.
 *
 * For the :443 conf, the SSL directives that certbot inserts are preserved
 * intact so we don't lose the cert wiring — we only replace the routing body.
 */
function regenerateWebmailVhost(domain) {
  sanitizeDomain(domain);
  const subdomain = `webmail.${domain}`;
  const confPath    = path.join(SITES_AVAILABLE, `${subdomain}.conf`);
  const sslConfPath = path.join(SITES_AVAILABLE, `${subdomain}-le-ssl.conf`);
  let touched = false;

  if (fs.existsSync(confPath)) {
    fs.writeFileSync(confPath, `<VirtualHost *:80>\n${webmailVhostBody(subdomain)}\n</VirtualHost>\n`);
    touched = true;
  }

  if (fs.existsSync(sslConfPath)) {
    const original = fs.readFileSync(sslConfPath, 'utf8');
    // Pull SSL-related lines (cert paths + include) from the existing conf so
    // we don't have to know certbot's exact paths.
    const sslLines = original
      .split('\n')
      .filter(l => /^\s*(SSLCertificate|SSLEngine|Include\s+\/etc\/letsencrypt|SSLProtocol|SSLCipher|SSLHonor)/i.test(l))
      .map(l => l.replace(/^\s+/, '    '));
    if (sslLines.length === 0) {
      // Fallback to standard certbot paths if we somehow can't find them.
      sslLines.push(`    SSLEngine on`);
      sslLines.push(`    SSLCertificateFile /etc/letsencrypt/live/${subdomain}/fullchain.pem`);
      sslLines.push(`    SSLCertificateKeyFile /etc/letsencrypt/live/${subdomain}/privkey.pem`);
      sslLines.push(`    Include /etc/letsencrypt/options-ssl-apache.conf`);
    }
    const sslConf = `<IfModule mod_ssl.c>
<VirtualHost *:443>
${webmailVhostBody(subdomain)}

${sslLines.join('\n')}
</VirtualHost>
</IfModule>
`;
    fs.writeFileSync(sslConfPath, sslConf);
    touched = true;
  }

  if (touched) {
    run('apache2ctl configtest', 'apache:configtest-webmail-regen', subdomain);
    run('systemctl reload apache2', 'apache:reload', subdomain);
  }
  return touched;
}

/**
 * Remove the webmail vhost for a domain (called when the domain is deleted
 * or mail DNS is torn down).  Non-fatal — safe to call even if it never existed.
 */
function deleteWebmailVhost(domain) {
  sanitizeDomain(domain);
  const subdomain = `webmail.${domain}`;
  const confPath  = path.join(SITES_AVAILABLE, `${subdomain}.conf`);
  try { run(`a2dissite ${subdomain}.conf`, 'apache:disable-webmail', subdomain); } catch (_) {}
  if (fs.existsSync(confPath)) fs.unlinkSync(confPath);
  // Also remove any certbot-generated SSL conf
  const sslConf = path.join(SITES_AVAILABLE, `${subdomain}-le-ssl.conf`);
  try { run(`a2dissite ${subdomain}-le-ssl.conf`, 'apache:disable-webmail-ssl', subdomain); } catch (_) {}
  if (fs.existsSync(sslConf)) fs.unlinkSync(sslConf);
  try { run('systemctl reload apache2', 'apache:reload', subdomain); } catch (_) {}
}

module.exports = {
  listVhosts, getVhostConfig,
  createVhost, enableVhost, disableVhost, deleteVhost, updateVhost,
  createWebmailVhost, deleteWebmailVhost, regenerateWebmailVhost,
  deleteAutoconfigVhost,
  assertHostnamesAvailable,
};
