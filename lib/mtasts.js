'use strict';
/**
 * lib/mtasts.js — MTA-STS policy + serving for outbound TLS enforcement.
 *
 * MTA-STS (RFC 8461) lets a domain advertise "my mail server speaks TLS;
 * if you can't verify my cert, refuse to deliver" — defending against
 * downgrade attacks. The policy lives in two places:
 *
 *   1. DNS: _mta-sts.<domain> TXT contains v=STSv1; id=<rotation-token>
 *   2. HTTPS: https://mta-sts.<domain>/.well-known/mta-sts.txt serves the
 *      actual policy (mode, mx, max_age).
 *
 * This module owns step 2 — generating the policy file and creating an
 * Apache vhost on mta-sts.<domain> that serves it. The DNS step is wired
 * into lib/dns.setupMailDns() and lib/state/domain.js' reconciler.
 *
 * The policy id is a date-based token; rotating it invalidates receiver
 * caches and forces a re-fetch (used when the MX or mode changes).
 */

const fs   = require('fs');
const path = require('path');
const { run, sanitizeDomain } = require('./shell');

const WEBROOT_BASE     = '/var/www';
const SITES_AVAILABLE  = '/etc/apache2/sites-available';

/**
 * Build the MTA-STS policy file body. Mode 'enforce' tells receivers to
 * refuse delivery when TLS verification fails; 'testing' is a soft launch
 * that only reports failures (still uses opportunistic TLS).
 */
function buildPolicy(domain, { mode = 'testing', maxAgeSeconds = 86400 } = {}) {
  return [
    'version: STSv1',
    `mode: ${mode}`,
    `mx: mail.${domain}`,
    `max_age: ${maxAgeSeconds}`,
    '',
  ].join('\n');
}

/**
 * Generate a stable per-day policy id. Same id all day, new id tomorrow —
 * receivers refetch when they see a different id.
 */
function todayId() {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * Write the policy file to /var/www/mta-sts.<domain>/.well-known/mta-sts.txt
 * and create an Apache vhost on mta-sts.<domain> that serves it.
 *
 * Idempotent. Returns the policy id so the caller can publish a matching
 * _mta-sts TXT record.
 */
function setupPolicy(domain, options = {}) {
  sanitizeDomain(domain);
  const mtaStsHost = `mta-sts.${domain}`;
  const docroot    = path.join(WEBROOT_BASE, mtaStsHost);
  const wellKnown  = path.join(docroot, '.well-known');

  fs.mkdirSync(wellKnown, { recursive: true });

  const policy = buildPolicy(domain, options);
  fs.writeFileSync(path.join(wellKnown, 'mta-sts.txt'), policy, { mode: 0o644 });

  // Apache vhost — serves only /.well-known/mta-sts.txt over HTTPS. The HTTP
  // vhost ALSO needs to exist so certbot's ACME challenge can land somewhere
  // (until ssl-mta-sts has issued a cert, HTTPS won't work).
  const confPath = path.join(SITES_AVAILABLE, `${mtaStsHost}.conf`);
  if (!fs.existsSync(confPath)) {
    fs.writeFileSync(confPath, `<VirtualHost *:80>
    ServerName ${mtaStsHost}
    DocumentRoot ${docroot}
    ErrorLog \${APACHE_LOG_DIR}/${mtaStsHost}_error.log
    CustomLog \${APACHE_LOG_DIR}/${mtaStsHost}_access.log combined

    <Directory ${docroot}>
        Options -Indexes +FollowSymLinks
        AllowOverride None
        Require all granted
    </Directory>
</VirtualHost>
`);
    try { run(`a2ensite ${mtaStsHost}.conf`, 'apache:enable-mta-sts', mtaStsHost); } catch (_) {}
    try { run('apache2ctl configtest',     'apache:configtest-mta-sts', mtaStsHost); } catch (_) {}
    try { run('systemctl reload apache2',  'apache:reload',             mtaStsHost); } catch (_) {}
  }

  return { id: todayId(), docroot, mtaStsHost };
}

/**
 * Tear down: remove the policy file, the vhost, and (best-effort) the cert.
 * Called from lib/state/domain.js destroy.
 */
function teardownPolicy(domain) {
  sanitizeDomain(domain);
  const mtaStsHost = `mta-sts.${domain}`;
  const docroot    = path.join(WEBROOT_BASE, mtaStsHost);
  const confPath   = path.join(SITES_AVAILABLE, `${mtaStsHost}.conf`);
  const sslConf    = path.join(SITES_AVAILABLE, `${mtaStsHost}-le-ssl.conf`);

  try { run(`a2dissite ${mtaStsHost}.conf`,        'apache:disable-mta-sts',     mtaStsHost); } catch (_) {}
  try { run(`a2dissite ${mtaStsHost}-le-ssl.conf`, 'apache:disable-mta-sts-ssl', mtaStsHost); } catch (_) {}
  if (fs.existsSync(confPath)) fs.unlinkSync(confPath);
  if (fs.existsSync(sslConf))  fs.unlinkSync(sslConf);
  if (fs.existsSync(docroot))  fs.rmSync(docroot, { recursive: true, force: true });
  try { run('systemctl reload apache2', 'apache:reload', mtaStsHost); } catch (_) {}
}

module.exports = { setupPolicy, teardownPolicy, buildPolicy, todayId };
