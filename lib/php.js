'use strict';
const fs   = require('fs');
const { execSync } = require('child_process');
const { run, runAsync, sanitizeDomain } = require('./shell');

const SUPPORTED = ['8.2', '8.3', '8.4', '8.5'];
const EXTENSIONS = [
  'fpm', 'cli', 'common',
  'mysql', 'xml', 'curl', 'gd', 'mbstring', 'zip', 'intl',
  'bcmath', 'soap', 'readline', 'redis', 'sqlite3',
  'imagick', 'igbinary', 'apcu', 'xsl'
];

// ── Detection helpers ─────────────────────────────────────────────────────────
function isInstalled(version) {
  try { execSync(`dpkg -s php${version}-fpm 2>/dev/null | grep -q "^Status: install"`, { stdio: 'pipe' }); return true; }
  catch (_) {
    try { execSync(`which php${version} 2>/dev/null`, { stdio: 'pipe' }); return true; }
    catch (_) { return false; }
  }
}

function isFpmActive(version) {
  try {
    return execSync(`systemctl is-active php${version}-fpm 2>/dev/null`, { encoding: 'utf8' }).trim() === 'active';
  } catch (_) { return false; }
}

function getDefaultVersion() {
  // Check which PHP FPM conf is enabled in Apache
  try {
    const enabled = fs.readdirSync('/etc/apache2/conf-enabled');
    for (const f of enabled) {
      const m = f.match(/^php(\d+\.\d+)-fpm\.conf$/);
      if (m) return m[1];
    }
  } catch (_) {}
  // Fallback: check CLI symlink
  try {
    const link = execSync('readlink /usr/bin/php 2>/dev/null', { encoding: 'utf8' }).trim();
    const m = link.match(/php(\d+\.\d+)/);
    if (m) return m[1];
  } catch (_) {}
  return null;
}

function getFullVersion(version) {
  try { return execSync(`php${version} -r "echo PHP_VERSION;" 2>/dev/null`, { encoding: 'utf8' }).trim(); }
  catch (_) { return version; }
}

// ── Parse per-domain PHP override from vhost conf ─────────────────────────────
function getDomainPhp(domain) {
  const confPath = `/etc/apache2/sites-available/${domain}.conf`;
  if (!fs.existsSync(confPath)) return null;
  const m = fs.readFileSync(confPath, 'utf8').match(/proxy:unix:\/run\/php\/php(\d+\.\d+)-fpm\.sock/);
  return m ? m[1] : null;
}

// ── listInstalled / listAvailable ─────────────────────────────────────────────
function listInstalled() {
  const def = getDefaultVersion();
  return SUPPORTED.filter(isInstalled).map(v => ({
    version:       v,
    fullVersion:   getFullVersion(v),
    fpmActive:     isFpmActive(v),
    isDefault:     def === v,
  }));
}

function listAvailable() {
  return SUPPORTED.filter(v => !isInstalled(v));
}

// ── installVersion ────────────────────────────────────────────────────────────
async function installVersion(version) {
  if (!SUPPORTED.includes(version)) throw new Error(`Unsupported PHP version: ${version}`);
  const pkgs = EXTENSIONS.map(e => `php${version}-${e}`).join(' ');
  const out  = await runAsync(
    `DEBIAN_FRONTEND=noninteractive apt-get install -y ${pkgs} 2>&1`,
    'php:install', version
  );
  // Start FPM
  try { execSync(`systemctl enable php${version}-fpm && systemctl start php${version}-fpm 2>/dev/null`); } catch (_) {}
  return out;
}

// ── setDefault — switches global Apache + CLI PHP version ─────────────────────
function setDefault(version) {
  if (!SUPPORTED.includes(version))  throw new Error(`Unsupported PHP version: ${version}`);
  if (!isInstalled(version))         throw new Error(`PHP ${version} is not installed.`);

  // Disable all FPM confs, then enable selected
  for (const v of SUPPORTED) {
    try { execSync(`a2disconf php${v}-fpm 2>/dev/null`); } catch (_) {}
  }
  run(`a2enconf php${version}-fpm`, 'php:set-default', version);
  // Update CLI default via alternatives
  try { execSync(`update-alternatives --set php /usr/bin/php${version} 2>/dev/null`); } catch (_) {}
  run('apache2ctl configtest', 'php:configtest', version);
  run('systemctl reload apache2', 'php:reload', version);
}

// ── setDomainPhp — per-vhost PHP version override ────────────────────────────
function setDomainPhp(domain, version) {
  sanitizeDomain(domain);
  if (version && !SUPPORTED.includes(version)) throw new Error(`Unsupported PHP version: ${version}`);
  if (version && !isInstalled(version))        throw new Error(`PHP ${version} is not installed.`);

  const MARKER = /\n[ \t]*# DPanel-PHP[\s\S]*?<\/FilesMatch>/g;
  const block  = version
    ? `\n    # DPanel-PHP\n    <FilesMatch \\.php$>\n        SetHandler "proxy:unix:/run/php/php${version}-fpm.sock|fcgi://localhost"\n    </FilesMatch>`
    : '';

  function patch(confPath) {
    if (!fs.existsSync(confPath)) return;
    let conf = fs.readFileSync(confPath, 'utf8');
    conf = conf.replace(MARKER, '');
    if (version) {
      // Insert before last </VirtualHost>
      const idx = conf.lastIndexOf('</VirtualHost>');
      if (idx !== -1) conf = conf.slice(0, idx) + block + '\n' + conf.slice(idx);
    }
    fs.writeFileSync(confPath, conf);
  }

  patch(`/etc/apache2/sites-available/${domain}.conf`);
  patch(`/etc/apache2/sites-available/${domain}-le-ssl.conf`);

  run('apache2ctl configtest', 'php:domain-configtest', domain);
  run('systemctl reload apache2', 'php:domain-reload', domain);
}

// ── removeVersion ─────────────────────────────────────────────────────────────
async function removeVersion(version) {
  if (!SUPPORTED.includes(version)) throw new Error(`Unsupported PHP version: ${version}`);
  if (getDefaultVersion() === version)
    throw new Error(`PHP ${version} is the active default — set a different default first.`);

  try { execSync(`a2disconf php${version}-fpm 2>/dev/null`); } catch (_) {}
  try { execSync(`systemctl stop php${version}-fpm 2>/dev/null`); } catch (_) {}
  const out = await runAsync(
    `DEBIAN_FRONTEND=noninteractive apt-get remove -y --purge "php${version}*" 2>&1`,
    'php:remove', version
  );
  try { execSync('systemctl reload apache2 2>/dev/null'); } catch (_) {}
  return out;
}

module.exports = {
  listInstalled, listAvailable,
  installVersion, setDefault, setDomainPhp, getDomainPhp,
  removeVersion, getDefaultVersion
};
