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

module.exports = { listVhosts, getVhostConfig, createVhost, enableVhost, disableVhost, deleteVhost, updateVhost };
