'use strict';
const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { runAsync, sanitizeDomain, logAction } = require('./shell');
const mysql = require('./mysql');
const crypto = require('crypto');

const WP_CLI = '/usr/local/bin/wp';

function isWpCliInstalled() {
  return fs.existsSync(WP_CLI);
}

async function installWpCli() {
  await runAsync(
    `curl -sS https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar -o ${WP_CLI} && chmod +x ${WP_CLI}`,
    'wp:install-cli', 'wp-cli'
  );
}

function wp(args, docRoot) {
  return execSync(`${WP_CLI} ${args} --path=${docRoot} --allow-root 2>&1`, { encoding: 'utf8', timeout: 60000 });
}

// ── Install WordPress ─────────────────────────────────────────────────────────
async function install({ domain, docRoot, dbName, dbUser, dbPassword, adminUser, adminPassword, adminEmail, siteTitle }) {
  sanitizeDomain(domain);

  // Ensure WP-CLI
  if (!isWpCliInstalled()) await installWpCli();

  // Ensure docroot exists
  if (!fs.existsSync(docRoot)) fs.mkdirSync(docRoot, { recursive: true });

  // Create DB + user if not provided
  if (mysql.isInstalled()) {
    try { mysql.createDatabase(dbName); } catch (_) {}
    try { mysql.createUser(dbUser, dbPassword, dbName); } catch (_) {}
  }

  // Download WordPress
  await runAsync(`${WP_CLI} core download --path=${docRoot} --allow-root --force 2>&1`, 'wp:download', domain);

  // Create wp-config.php
  execSync(`${WP_CLI} config create --path=${docRoot} --allow-root --dbname=${dbName} --dbuser=${dbUser} --dbpass=${JSON.stringify(dbPassword)} --dbhost=localhost --force 2>&1`);

  // Run install
  const safeTitle   = siteTitle.replace(/'/g, "\\'");
  const safeAdminPw = adminPassword.replace(/'/g, "\\'");
  execSync(
    `${WP_CLI} core install --path=${docRoot} --allow-root --url=https://${domain} --title='${safeTitle}' --admin_user=${adminUser} --admin_password='${safeAdminPw}' --admin_email=${adminEmail} --skip-email 2>&1`
  );

  // Fix permissions
  try { execSync(`chown -R www-data:www-data ${docRoot} 2>/dev/null`); } catch (_) {}
  try { execSync(`find ${docRoot} -type d -exec chmod 755 {} \\; 2>/dev/null`); } catch (_) {}
  try { execSync(`find ${docRoot} -type f -exec chmod 644 {} \\; 2>/dev/null`); } catch (_) {}

  logAction('wp:install', domain, 'ok');
  return { success: true };
}

// ── Check if WordPress is installed in a docroot ──────────────────────────────
function isInstalled(docRoot) {
  return fs.existsSync(path.join(docRoot, 'wp-config.php'));
}

// ── Get WordPress version ─────────────────────────────────────────────────────
function getVersion(docRoot) {
  try { return wp('core version', docRoot).trim(); }
  catch (_) { return null; }
}

module.exports = { install, isInstalled, getVersion, isWpCliInstalled, installWpCli };
