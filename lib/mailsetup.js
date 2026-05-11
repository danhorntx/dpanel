'use strict';
/**
 * lib/mailsetup.js — Idempotent mail auto-configuration setup
 *
 * For each domain, creates:
 *  1. DNS A records: autoconfig, autodiscover, webmail  → SERVER_IP
 *  2. Apache vhost:  autoconfig.<domain>  (ServerAlias autodiscover, webmail)
 *  3. Static files:  RFC 6186 XML, Autodiscover XML + PHP, iOS .mobileconfig
 *  4. SSL cert:      certbot for autoconfig/autodiscover/webmail subdomains
 *
 * Safe to call repeatedly — each step checks whether it's already done.
 */

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const dns        = require('./dns');
const mailconfig = require('./mailconfig');
const { runAsync, sanitizeDomain } = require('./shell');

const SITES_AVAILABLE = '/etc/apache2/sites-available';
const WEBROOT_BASE    = '/var/www';

/**
 * setupMailAutoconfig(domain)
 * Returns { dns, apache, ssl, mobileconfig, errors }
 */
async function setupMailAutoconfig(domain) {
  sanitizeDomain(domain);
  const result = { dns: false, apache: false, ssl: false, mobileconfig: false, errors: [] };
  const autoconf = `autoconfig.${domain}`;
  const webroot  = path.join(WEBROOT_BASE, autoconf);
  const email    = `admin@${domain}`;

  // ── Step 1: DNS records ───────────────────────────────────────────────────
  // Always overwrite — dns.addRecord replaces existing A records with the same
  // name. Skipping based on existence was a footgun: when the server IP changed
  // (e.g. prod → staging migration) the records pointed at the wrong host
  // forever, breaking ACME for autoconfig/autodiscover subdomains.
  //
  // Resolves zone + prefix so subdomains (e.g. mail-enabled app.example.com)
  // get their autoconfig records into the parent zone under prefixed names
  // (autoconfig.app, autodiscover.app, webmail.app) instead of being skipped.
  const { zone, prefix } = dns.resolveZoneAndPrefix(domain);
  if (zone) {
    try {
      for (const sub of ['autoconfig', 'autodiscover', 'webmail']) {
        const name = prefix ? `${sub}.${prefix}` : sub;
        dns.addRecord(zone, { name, ttl: 14400, type: 'A', value: dns.SERVER_IP });
      }
      result.dns = true;
    } catch (err) {
      result.errors.push(`DNS: ${err.message}`);
    }
  } else {
    result.errors.push(`DNS: No managed zone for ${domain} or any parent — add DNS records manually`);
  }

  // ── Step 2: Static config files ───────────────────────────────────────────
  try {
    // Create directory structure
    for (const sub of ['mail', 'autodiscover', 'mobileconfig', '.well-known/acme-challenge']) {
      fs.mkdirSync(path.join(webroot, sub), { recursive: true });
    }
    // Write / refresh config files (always overwrite — domain config never changes)
    fs.writeFileSync(
      path.join(webroot, 'mail', 'config-v1.1.xml'),
      mailconfig.autoconfigXml(domain), 'utf8'
    );
    fs.writeFileSync(
      path.join(webroot, 'autodiscover', 'autodiscover.xml'),
      mailconfig.autodiscoverXml(domain), 'utf8'
    );
    fs.writeFileSync(
      path.join(webroot, 'autodiscover', 'autodiscover.php'),
      mailconfig.autodiscoverPhp(domain), 'utf8'
    );
    fs.writeFileSync(
      path.join(webroot, 'mobileconfig', `${domain}.mobileconfig`),
      mailconfig.mobileconfigPlist(domain), 'utf8'
    );
    result.mobileconfig = true;
  } catch (err) {
    result.errors.push(`Files: ${err.message}`);
  }

  // ── Step 3: Apache vhost ──────────────────────────────────────────────────
  const confPath = path.join(SITES_AVAILABLE, `${autoconf}.conf`);
  try {
    if (!fs.existsSync(confPath)) {
      // NOTE: autoconfig vhost serves XML config files only. It MUST NOT claim
      // webmail.<domain> as a ServerAlias — webmail has its own vhost that
      // proxies to the panel. Mixing them was the cause of 403 errors on
      // webmail (apache picked whichever vhost alphabetized first).
      const conf = `<VirtualHost *:80>
    ServerName ${autoconf}
    ServerAlias autodiscover.${domain}
    DocumentRoot ${webroot}
    ErrorLog \${APACHE_LOG_DIR}/${autoconf}_error.log
    CustomLog \${APACHE_LOG_DIR}/${autoconf}_access.log combined

    RewriteEngine on
    # Serve autodiscover.xml for both GET and POST (Outlook autodiscover)
    RewriteRule ^/autodiscover/autodiscover\\.xml$ /autodiscover/autodiscover.php [L]

    <Directory ${webroot}>
        Options -Indexes +FollowSymLinks
        AllowOverride None
        Require all granted
    </Directory>

    # iOS mobileconfig: correct MIME type
    <FilesMatch "\\.mobileconfig$">
        Header always set Content-Type "application/x-apple-aspen-config"
        Header always set Content-Disposition "attachment"
    </FilesMatch>

    # CORS for autoconfig (email clients may cross-origin fetch)
    <FilesMatch "\\.(xml|php)$">
        Header always set Access-Control-Allow-Origin "*"
    </FilesMatch>
</VirtualHost>
`;
      fs.writeFileSync(confPath, conf);
    }
    // Enable modules and site
    try { execSync('a2enmod rewrite headers', { timeout: 10000, stdio: 'pipe' }); } catch (_) {}
    try { execSync(`a2ensite ${autoconf}.conf`, { timeout: 10000, stdio: 'pipe' }); } catch (_) {}
    try { execSync('apache2ctl -t', { timeout: 10000, stdio: 'pipe' }); } catch (_) {}
    try { execSync('systemctl reload apache2', { timeout: 15000, stdio: 'pipe' }); } catch (_) {}
    result.apache = true;
  } catch (err) {
    result.errors.push(`Apache: ${err.message}`);
  }

  // ── Step 4: SSL cert ──────────────────────────────────────────────────────
  try {
    const certPath = `/etc/letsencrypt/live/${autoconf}/fullchain.pem`;
    if (!fs.existsSync(certPath)) {
      // Run certbot — may fail if DNS hasn't propagated yet; that's OK.
      // webmail.<domain> is intentionally NOT in this SAN — it has its own
      // vhost + its own cert issued separately (see lib/apache.createWebmailVhost
      // + routes/domains.js). Bundling them caused certbot to write a
      // webmail.<domain> ServerAlias into the autoconfig SSL conf and steal
      // webmail traffic.
      await runAsync(
        `certbot --apache -d ${autoconf} -d autodiscover.${domain}` +
        ` --non-interactive --agree-tos --email ${email} --expand --redirect`,
        'ssl:autoconfig', autoconf
      );
    }
    result.ssl = true;
  } catch (err) {
    // SSL failure is non-fatal — the other steps are still useful
    result.errors.push(`SSL: ${err.message.slice(0, 300)}`);
  }

  return result;
}

/**
 * getMobileconfigUrl(domain)
 * Returns the public URL for the iOS mobileconfig download.
 */
function getMobileconfigUrl(domain) {
  return `https://autoconfig.${domain}/mobileconfig/${domain}.mobileconfig`;
}

/**
 * getAutoconfigUrls(domain)
 * Returns all relevant auto-config URLs for display in the dashboard.
 */
function getAutoconfigUrls(domain) {
  return {
    autoconfig:   `https://autoconfig.${domain}/mail/config-v1.1.xml`,
    autodiscover: `https://autodiscover.${domain}/autodiscover/autodiscover.xml`,
    mobileconfig: `https://autoconfig.${domain}/mobileconfig/${domain}.mobileconfig`,
    webmail:      `https://webmail.${domain}/`,
  };
}

module.exports = { setupMailAutoconfig, getMobileconfigUrl, getAutoconfigUrls };
