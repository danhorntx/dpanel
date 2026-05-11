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
const { execSync } = require('child_process');
const { regenerateWebmailVhost } = require('../lib/apache');

const SITES_AVAILABLE = '/etc/apache2/sites-available';

/**
 * Pre-v2.0 installs shipped an `autoconfig.<domain>` vhost that claimed
 * `webmail.<domain>` as a ServerAlias. Because Apache loads sites
 * alphabetically, the autoconfig vhost would intercept requests for
 * webmail.<domain> on any site whose autoconfig.* conf was older than
 * the dedicated webmail.* conf — resulting in a 403 on the new SPA.
 *
 * The DPanel code itself was fixed at v2.0, but leftover confs from
 * pre-v2 installs never get rewritten on `git pull` because the generator
 * is gated on `!fs.existsSync(confPath)`. This sweep handles that.
 *
 * Safe and idempotent — only edits files that actually contain the
 * overreach, makes a timestamped backup before each change, and runs
 * apache2ctl configtest before reloading.
 */
function fixAutoconfigOverreach() {
  const files = fs.readdirSync(SITES_AVAILABLE)
    .filter(f => /^autoconfig\..+\.conf$/.test(f))
    .map(f => path.join(SITES_AVAILABLE, f));

  let touched = 0;
  for (const file of files) {
    const original = fs.readFileSync(file, 'utf8');
    const m = file.match(/autoconfig\.(.+?)(?:-le-ssl)?\.conf$/);
    if (!m) continue;
    const domain = m[1];
    const webmailHost = `webmail.${domain}`;

    if (!original.includes(webmailHost)) continue;

    const updated = original
      // Strip from ServerAlias line(s)
      .replace(new RegExp(`(\\s)${webmailHost.replace(/\./g, '\\.')}(\\s|$)`, 'g'), '$1$2')
      // Strip the redirect-to-https RewriteCond
      .replace(new RegExp(`^\\s*RewriteCond\\s+%\\{SERVER_NAME\\}\\s*=\\s*${webmailHost.replace(/\./g, '\\.')}\\s*(\\[OR\\])?\\s*$\n`, 'gm'), '')
      // Collapse trailing whitespace on alias lines we trimmed
      .replace(/(\s)ServerAlias\s+\n/g, '$1ServerAlias\n');

    if (updated === original) continue;
    fs.writeFileSync(file + `.bak.${Date.now()}`, original);
    fs.writeFileSync(file, updated);
    console.log(`  ✓ ${path.basename(file)} (stripped ${webmailHost} alias)`);
    touched++;
  }
  return touched;
}

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
  console.log('Sweeping autoconfig.*.conf for stale webmail aliases…');
  const fixed = fixAutoconfigOverreach();
  if (fixed > 0) {
    console.log(`  Patched ${fixed} autoconfig vhost(s). Apache reload happens after webmail migration.`);
  } else {
    console.log('  None found.');
  }

  const domains = listWebmailDomains();
  if (domains.length === 0) {
    console.log('No webmail.* vhosts found — nothing to migrate.');
    if (fixed > 0) {
      execSync('apache2ctl configtest', { stdio: 'inherit' });
      execSync('systemctl reload apache2', { stdio: 'inherit' });
    }
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
