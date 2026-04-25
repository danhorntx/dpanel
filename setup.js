#!/usr/bin/env node
'use strict';
const readline = require('readline');
const bcrypt   = require('bcryptjs');
const crypto   = require('crypto');
const fs       = require('fs');
const path     = require('path');
const { execSync } = require('child_process');

const CONFIG_FILE = path.join(__dirname, 'config.json');
const CERT_DIR    = path.join(__dirname, 'certs');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = q => new Promise(r => rl.question(q, r));

async function main() {
  console.log('\n╔══════════════════════════════╗');
  console.log('║   DPanel — First-run Setup   ║');
  console.log('╚══════════════════════════════╝\n');

  // Load existing config if re-running
  let existing = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try { existing = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch(_) {}
  }

  const username = await ask(`Admin username [${existing.username || 'admin'}]: `);
  const pw1 = await ask('Admin password: ');
  const pw2 = await ask('Confirm password: ');
  if (pw1 !== pw2) { console.error('Passwords do not match.'); process.exit(1); }
  if (pw1.length < 8) { console.error('Password must be at least 8 characters.'); process.exit(1); }

  const hash = await bcrypt.hash(pw1, 12);
  const sessionSecret = crypto.randomBytes(64).toString('hex');

  const config = {
    username: username.trim() || existing.username || 'admin',
    passwordHash: hash,
    sessionSecret: existing.sessionSecret || sessionSecret,
  };

  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  execSync(`chmod 600 ${CONFIG_FILE}`);
  console.log('\n✓ Config saved to config.json (mode 600)');

  // Generate self-signed cert if not present
  if (!fs.existsSync(path.join(CERT_DIR, 'dpanel.crt'))) {
    fs.mkdirSync(CERT_DIR, { recursive: true });
    console.log('\nGenerating self-signed SSL certificate...');
    try {
      execSync(`openssl req -x509 -newkey rsa:4096 -keyout ${CERT_DIR}/dpanel.key -out ${CERT_DIR}/dpanel.crt -days 3650 -nodes -subj "/CN=dpanel.local"`, { stdio: 'inherit' });
      execSync(`chmod 600 ${CERT_DIR}/dpanel.key ${CERT_DIR}/dpanel.crt`);
      console.log('✓ Self-signed cert generated');
    } catch (e) {
      console.warn('⚠ Could not generate cert. DPanel will run on HTTP.');
    }
  }

  rl.close();
  console.log('\n✓ Setup complete! Start the panel with: node server.js');
  console.log('  Or via systemd: systemctl start dpanel\n');
}

main().catch(e => { console.error(e); process.exit(1); });
