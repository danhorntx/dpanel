#!/usr/bin/env node
'use strict';

/**
 * One-shot migration: regenerate every existing webmail.<domain> Apache
 * vhost to the new template that serves the DPanel webmail SPA (new) by
 * default and falls back to the classic webmail (legacy /webmail path on
 * 8080) when the user carries a `webmail_mode=classic` cookie.
 *
 * Safe to run multiple times — each call overwrites the conf file with the
 * current template. SSL directives from the certbot-generated -le-ssl.conf
 * are preserved so we don't have to know the cert paths.
 *
 * Usage:
 *   sudo node /opt/dpanel/scripts/migrate-webmail-vhosts.js
 */

const fs   = require('fs');
const path = require('path');
const { regenerateWebmailVhost } = require('../lib/apache');

const SITES_AVAILABLE = '/etc/apache2/sites-available';

function listWebmailDomains() {
  if (!fs.existsSync(SITES_AVAILABLE)) {
    console.error(`Apache sites dir not found: ${SITES_AVAILABLE}`);
    process.exit(1);
  }
  return fs.readdirSync(SITES_AVAILABLE)
    .filter(f => f.startsWith('webmail.') && f.endsWith('.conf') && !f.endsWith('-le-ssl.conf'))
    .map(f => f.slice('webmail.'.length, -'.conf'.length));
}

function main() {
  const domains = listWebmailDomains();
  if (domains.length === 0) {
    console.log('No webmail.* vhosts found — nothing to migrate.');
    return;
  }

  console.log(`Found ${domains.length} webmail vhost(s) to regenerate:`);
  for (const domain of domains) console.log(`  webmail.${domain}`);

  let ok = 0, fail = 0;
  for (const domain of domains) {
    try {
      regenerateWebmailVhost(domain);
      ok++;
      console.log(`  ✓ webmail.${domain}`);
    } catch (err) {
      fail++;
      console.error(`  ✗ webmail.${domain}: ${err.message}`);
    }
  }
  console.log(`Done — ${ok} succeeded, ${fail} failed.`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
