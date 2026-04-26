'use strict';
const { execSync } = require('child_process');
const { run, logAction } = require('./shell');

function isEnabled() {
  try {
    return execSync('ufw status 2>/dev/null', { encoding: 'utf8' }).includes('Status: active');
  } catch (_) { return false; }
}

function enable() {
  execSync("echo 'y' | ufw enable 2>/dev/null");
  logAction('firewall:enable', 'ufw', 'ok');
}

function disable() {
  execSync('ufw disable 2>/dev/null');
  logAction('firewall:disable', 'ufw', 'ok');
}

function listRules() {
  try {
    const out = execSync('ufw status numbered 2>/dev/null', { encoding: 'utf8' });
    const rules = [];
    const lines = out.split('\n');
    for (const line of lines) {
      const m = line.match(/^\[\s*(\d+)\]\s+(.+?)\s{2,}(ALLOW|DENY|REJECT|LIMIT)\s+(IN|OUT|FWD|FROM|TO)?\s*(.*)$/i);
      if (m) {
        rules.push({
          num:    parseInt(m[1]),
          to:     m[2].trim(),
          action: m[3].toUpperCase(),
          dir:    m[4] || 'IN',
          from:   m[5].trim() || 'Anywhere',
          raw:    line,
        });
      }
    }
    // Fallback: parse simpler format
    if (!rules.length) {
      for (const line of lines) {
        const m2 = line.match(/^\[\s*(\d+)\]\s+(.+)$/);
        if (m2) rules.push({ num: parseInt(m2[1]), raw: m2[2].trim(), to: m2[2].trim(), action: '', dir: '', from: '' });
      }
    }
    return rules;
  } catch (_) { return []; }
}

function allowPort(port, proto, comment) {
  if (!/^\d{1,5}(\/\d{1,5})?$/.test(String(port))) throw new Error('Invalid port.');
  const protoStr = proto === 'udp' ? '/udp' : '/tcp';
  run(`ufw allow ${port}${protoStr} comment ${JSON.stringify(comment || '')} 2>/dev/null`, 'firewall:allow', `${port}${protoStr}`);
}

function denyPort(port, proto) {
  if (!/^\d{1,5}$/.test(String(port))) throw new Error('Invalid port.');
  const protoStr = proto === 'udp' ? '/udp' : '/tcp';
  run(`ufw deny ${port}${protoStr} 2>/dev/null`, 'firewall:deny', `${port}${protoStr}`);
}

function blockIp(ip) {
  if (!/^[\d.:a-fA-F/]+$/.test(ip)) throw new Error('Invalid IP address.');
  run(`ufw deny from ${ip} 2>/dev/null`, 'firewall:block-ip', ip);
}

function deleteRule(num) {
  if (!/^\d+$/.test(String(num))) throw new Error('Invalid rule number.');
  execSync(`echo 'y' | ufw delete ${num} 2>/dev/null`);
  logAction('firewall:delete-rule', String(num), 'ok');
}

function getStatus() {
  try {
    const out = execSync('ufw status verbose 2>/dev/null', { encoding: 'utf8' });
    return { enabled: out.includes('Status: active'), raw: out };
  } catch (_) { return { enabled: false, raw: '' }; }
}

module.exports = { isEnabled, enable, disable, listRules, allowPort, denyPort, blockIp, deleteRule, getStatus };
