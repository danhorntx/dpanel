'use strict';
const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { runAsync, sanitizeDomain, logAction } = require('./shell');
const crypto = require('crypto');

const CONFIG_FILE = path.join(__dirname, '..', 'data', 'git-deploys.json');

function ensureData() {
  const dir = path.dirname(CONFIG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(CONFIG_FILE)) fs.writeFileSync(CONFIG_FILE, '{}');
}

function readConfig() {
  ensureData();
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch (_) { return {}; }
}

function writeConfig(data) {
  ensureData();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2));
}

// ── Get deploy config for a domain ───────────────────────────────────────────
function getConfig(domain) {
  return readConfig()[domain] || null;
}

// ── Save deploy config ────────────────────────────────────────────────────────
function saveConfig(domain, { repoUrl, branch, buildCommand, docRoot }) {
  sanitizeDomain(domain);
  const config = readConfig();
  // Generate a webhook secret if not already set
  const existing = config[domain] || {};
  config[domain] = {
    repoUrl:      repoUrl || existing.repoUrl,
    branch:       branch || existing.branch || 'main',
    buildCommand: buildCommand !== undefined ? buildCommand : (existing.buildCommand || ''),
    docRoot:      docRoot || existing.docRoot,
    webhookSecret: existing.webhookSecret || crypto.randomBytes(20).toString('hex'),
    lastDeploy:   existing.lastDeploy || null,
    lastCommit:   existing.lastCommit || null,
  };
  writeConfig(config);
  return config[domain];
}

// ── Remove deploy config ──────────────────────────────────────────────────────
function removeConfig(domain) {
  const config = readConfig();
  delete config[domain];
  writeConfig(config);
}

// ── Deploy ────────────────────────────────────────────────────────────────────
async function deploy(domain) {
  sanitizeDomain(domain);
  const cfg = getConfig(domain);
  if (!cfg) throw new Error('No git deploy configured for this domain.');

  const { repoUrl, branch, buildCommand, docRoot } = cfg;
  if (!docRoot || !repoUrl) throw new Error('Missing repoUrl or docRoot in config.');

  let output = '';

  // Clone or pull
  const gitDir = path.join(docRoot, '.git');
  if (fs.existsSync(gitDir)) {
    output += await runAsync(`git -C ${docRoot} fetch origin && git -C ${docRoot} reset --hard origin/${branch} 2>&1`, 'git:pull', domain);
  } else {
    output += await runAsync(`git clone --depth=1 --branch ${branch} ${repoUrl} ${docRoot} 2>&1`, 'git:clone', domain);
  }

  // Get commit hash
  let commit = '';
  try { commit = execSync(`git -C ${docRoot} rev-parse --short HEAD 2>/dev/null`, { encoding: 'utf8' }).trim(); } catch (_) {}

  // Run build command
  if (buildCommand && buildCommand.trim()) {
    output += '\n--- build ---\n';
    output += await runAsync(`cd ${docRoot} && ${buildCommand} 2>&1`, 'git:build', domain);
  }

  // Fix permissions
  try { execSync(`chown -R www-data:www-data ${docRoot} 2>/dev/null`); } catch (_) {}

  // Update last deploy info
  const config = readConfig();
  if (config[domain]) {
    config[domain].lastDeploy = new Date().toISOString();
    config[domain].lastCommit = commit;
    writeConfig(config);
  }

  logAction('git:deploy', domain, commit || 'ok');
  return { output, commit };
}

// ── Verify webhook signature ──────────────────────────────────────────────────
function verifyWebhook(domain, signature, body) {
  const cfg = getConfig(domain);
  if (!cfg?.webhookSecret) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', cfg.webhookSecret).update(body).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

module.exports = { getConfig, saveConfig, removeConfig, deploy, verifyWebhook };
