'use strict';
const fs = require('fs');
const path = require('path');
const { run, sanitizeDomain, sanitizePath } = require('./shell');

const SITES_AVAILABLE = '/etc/apache2/sites-available';
const SITES_ENABLED   = '/etc/apache2/sites-enabled';
const WEBROOT_BASE    = '/var/www';

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
  const confPath = path.join(SITES_AVAILABLE, `${domain}.conf`);
  if (fs.existsSync(confPath)) throw new Error(`Vhost already exists: ${domain}`);

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
  try { run(`a2dissite ${domain}.conf`, 'apache:disable-site', domain); } catch (_) {}
  if (fs.existsSync(confPath)) fs.unlinkSync(confPath);
  run('systemctl reload apache2', 'apache:reload', domain);
}

function updateVhost(domain, content) {
  sanitizeDomain(domain);
  const confPath = path.join(SITES_AVAILABLE, `${domain}.conf`);
  fs.writeFileSync(confPath, content);
  run('apache2ctl configtest', 'apache:configtest', domain);
  run('systemctl reload apache2', 'apache:reload', domain);
}

/**
 * Create a reverse-proxy vhost for webmail.<domain> that forwards all
 * traffic to the DPanel Node server (which serves /webmail, /css/*, /js/*,
 * and the webmail API at /webmail/api/*).
 *
 * Visiting webmail.<domain>/ redirects to webmail.<domain>/webmail so the
 * user lands on the webmail login page without having to remember the path.
 *
 * Idempotent — does nothing if the vhost already exists.
 */
function createWebmailVhost(domain) {
  sanitizeDomain(domain);
  const subdomain = `webmail.${domain}`;
  const confPath  = path.join(SITES_AVAILABLE, `${subdomain}.conf`);
  if (fs.existsSync(confPath)) return false; // already set up

  const conf = `<VirtualHost *:80>
    ServerName ${subdomain}

    # Proxy all requests to the DPanel server (serves webmail + all assets)
    SSLProxyEngine On
    SSLProxyVerify none
    SSLProxyCheckPeerCN off
    SSLProxyCheckPeerName off
    ProxyPreserveHost On
    ProxyPass / https://127.0.0.1:8080/
    ProxyPassReverse / https://127.0.0.1:8080/

    # Redirect bare root to /webmail so users just visit webmail.<domain>
    RewriteEngine On
    RewriteRule ^/?$ /webmail [R=302,L]

    ErrorLog \${APACHE_LOG_DIR}/${subdomain}_error.log
    CustomLog \${APACHE_LOG_DIR}/${subdomain}_access.log combined
</VirtualHost>
`;

  fs.writeFileSync(confPath, conf);
  run(`a2ensite ${subdomain}.conf`, 'apache:enable-webmail', subdomain);
  run('apache2ctl configtest', 'apache:configtest-webmail', subdomain);
  run('systemctl reload apache2', 'apache:reload', subdomain);
  return true;
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
  createWebmailVhost, deleteWebmailVhost,
};
