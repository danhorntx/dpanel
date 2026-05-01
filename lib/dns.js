'use strict';
/**
 * lib/dns.js — BIND9 zone management for DPanel
 *
 * Zone files live at /var/lib/bind/<domain>.db  (AppArmor-allowed path)
 * named.conf.local: /etc/bind/named.conf.local
 * Serial format: YYYYMMDDNN  (incremented same-day, reset daily)
 */

const fs         = require('fs');
const path       = require('path');
const { execSync } = require('child_process');

// ── Constants ─────────────────────────────────────────────────────────────────
const ZONE_DIR      = '/var/lib/bind';
const NAMED_CONF    = '/etc/bind/named.conf.local';
const SERVER_IP     = '<server-1-ip>';
const NS1           = 'ns1.danhorntx.com';
const NS2           = 'ns2.danhorntx.com';
const DEFAULT_TTL   = 14400;
const SOA_TTL       = 86400;

// ── Serial helpers ────────────────────────────────────────────────────────────
function todaySerial() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function nextSerial(current) {
  const prefix = todaySerial();
  const curStr = String(current);
  if (curStr.startsWith(prefix)) {
    const nn = parseInt(curStr.slice(8), 10) + 1;
    return `${prefix}${String(nn).padStart(2, '0')}`;
  }
  return `${prefix}01`;
}

// ── Zone file path ────────────────────────────────────────────────────────────
function zonePath(domain) {
  return path.join(ZONE_DIR, `${domain}.db`);
}

// ── Parse a zone file into a structured object ────────────────────────────────
// Returns: { serial, records: [{ name, ttl, type, value, priority? }] }
function parseZone(domain) {
  const file = zonePath(domain);
  if (!fs.existsSync(file)) throw new Error(`Zone not found: ${domain}`);
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');

  let serial = '0';
  const records = [];

  // Extract serial from SOA comment line: "; Serial: NNNNNNNNNN"
  for (const line of lines) {
    // Serial on its own line: "2026042601 ;Serial Number" OR "; Serial: 2026042601"
    const soam = line.match(/^\s*(\d{10})\s*;/);
    if (soam) { serial = soam[1]; break; }
    const sm = line.match(/;\s*Serial[:\s]+(\d+)/i);
    if (sm) { serial = sm[1]; break; }
  }

  // Strip inline comments while respecting quoted strings
  function stripComment(raw) {
    let inQuote = false;
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] === '"') inQuote = !inQuote;
      if (raw[i] === ';' && !inQuote) return raw.slice(0, i);
    }
    return raw;
  }

  // Parse resource records (skip SOA, NS, comments, $TTL, $ORIGIN)
  let inSoa = false;
  for (const raw of lines) {
    // Track multi-line SOA block
    if (/\bSOA\b/i.test(raw)) { inSoa = true; }
    if (inSoa) {
      if (raw.includes(')')) inSoa = false;
      continue; // skip all SOA lines
    }

    const line = stripComment(raw).trim();
    if (!line || line.startsWith('$') || line.startsWith('@')) continue;

    // Match: name [ttl] IN type value...
    const m = line.match(/^(\S+)\s+(?:(\d+)\s+)?IN\s+(\S+)\s+(.+)$/i);
    if (!m) continue;
    let [, name, ttl, type, value] = m;
    ttl = ttl ? parseInt(ttl, 10) : DEFAULT_TTL;
    type = type.toUpperCase();
    value = value.trim();

    // Skip NS records (infrastructure)
    if (type === 'NS') continue;

    // Strip trailing dot for display (except TXT which has quotes)
    if (type !== 'TXT') value = value.replace(/\.$/, '');

    // TXT: handle both simple "value" and multi-string ( "chunk1" "chunk2" ) format
    if (type === 'TXT') {
      if (value.trimStart().startsWith('(')) {
        // Multi-string: extract and concatenate all quoted substrings
        const parts = [];
        const qre = /"([^"]*)"/g;
        let qm;
        while ((qm = qre.exec(value)) !== null) parts.push(qm[1]);
        value = parts.join('');
      } else {
        // Simple quoted string — strip outer quotes
        value = value.replace(/^"(.*)"$/, '$1');
      }
    }

    // MX: split priority from target
    if (type === 'MX') {
      const mxm = value.match(/^(\d+)\s+(.+)$/);
      if (mxm) {
        // Preserve bare '.' (null MX, RFC 7505); strip trailing dot from FQDNs
        const mxVal = mxm[2] === '.' ? '.' : mxm[2].replace(/\.$/, '');
        records.push({ name, ttl, type, priority: parseInt(mxm[1], 10), value: mxVal });
        continue;
      }
    }

    records.push({ name, ttl, type, value });
  }

  return { serial, records };
}

// ── Render records array → zone file text ─────────────────────────────────────
function renderZone(domain, serial, records) {
  const lines = [
    `; Zone file for ${domain} — managed by DPanel`,
    `; DO NOT EDIT MANUALLY`,
    `$TTL ${DEFAULT_TTL}`,
    ``,
    `; SOA`,
    `${domain}.  ${SOA_TTL}  IN  SOA  ${NS1}.  admin.${domain}. (`,
    `                ${serial}  ; Serial`,
    `                3600       ; Refresh`,
    `                900        ; Retry`,
    `                604800     ; Expire`,
    `                300 )      ; Minimum TTL`,
    ``,
    `; Name servers`,
    `${domain}.  ${SOA_TTL}  IN  NS   ${NS1}.`,
    `${domain}.  ${SOA_TTL}  IN  NS   ${NS2}.`,
    ``,
    `; Records`,
  ];

  for (const r of records) {
    const name = r.name.endsWith('.') ? r.name : (r.name === domain ? `${domain}.` : r.name);
    if (r.type === 'MX') {
      const mxPriority = (r.priority !== null && r.priority !== undefined) ? r.priority : 10;
      const mxTarget   = r.value === '.' ? '.' : (r.value.endsWith('.') ? r.value : r.value + '.');
      lines.push(`${name}  ${r.ttl}  IN  MX   ${mxPriority} ${mxTarget}`);
    } else if (r.type === 'TXT') {
      // BIND requires each TXT string to be ≤255 bytes.
      // Strip outer quotes if already present, then chunk.
      const raw = (r.value.startsWith('"') && r.value.endsWith('"'))
        ? r.value.slice(1, -1)
        : r.value;
      if (raw.length <= 255) {
        lines.push(`${name}  ${r.ttl}  IN  TXT  "${raw}"`);
      } else {
        const chunks = [];
        for (let i = 0; i < raw.length; i += 255) {
          chunks.push(`"${raw.slice(i, i + 255)}"`);
        }
        lines.push(`${name}  ${r.ttl}  IN  TXT  ( ${chunks.join(' ')} )`);
      }
    } else if (r.type === 'CNAME') {
      lines.push(`${name}  ${r.ttl}  IN  CNAME  ${r.value.endsWith('.') ? r.value : r.value + '.'}`);
    } else {
      lines.push(`${name}  ${r.ttl}  IN  ${r.type.padEnd(4)}  ${r.value}`);
    }
  }

  return lines.join('\n') + '\n';
}

// ── Reload BIND ───────────────────────────────────────────────────────────────
function reloadBind() {
  try {
    execSync('rndc reload', { timeout: 10000 });
  } catch (err) {
    // rndc might fail if BIND isn't running — try restarting
    try { execSync('systemctl reload-or-restart named', { timeout: 15000 }); }
    catch (_) { /* best effort */ }
  }
}

// ── Check if a zone exists ────────────────────────────────────────────────────
function zoneExists(domain) {
  return fs.existsSync(zonePath(domain));
}

// ── List all managed zones ────────────────────────────────────────────────────
function listZones() {
  // Read zones from named.conf.local
  if (!fs.existsSync(NAMED_CONF)) return [];
  const conf = fs.readFileSync(NAMED_CONF, 'utf8');
  const matches = conf.matchAll(/zone\s+"([^"]+)"\s*\{[^}]*type\s+master/gi);
  const zones = [];
  for (const m of matches) {
    const domain = m[1];
    const exists = zoneExists(domain);
    let recordCount = 0;
    try {
      if (exists) recordCount = parseZone(domain).records.length;
    } catch (_) {}
    zones.push({ domain, recordCount });
  }
  return zones;
}

// ── Register zone in named.conf.local ────────────────────────────────────────
function registerZone(domain) {
  const entry = `\nzone "${domain}" {\n    type master;\n    file "${ZONE_DIR}/${domain}.db";\n    allow-update { none; };\n};\n`;
  let conf = fs.existsSync(NAMED_CONF) ? fs.readFileSync(NAMED_CONF, 'utf8') : '';
  if (conf.includes(`zone "${domain}"`)) return; // already registered
  fs.appendFileSync(NAMED_CONF, entry);
}

// ── Remove zone from named.conf.local ────────────────────────────────────────
function unregisterZone(domain) {
  if (!fs.existsSync(NAMED_CONF)) return;
  let conf = fs.readFileSync(NAMED_CONF, 'utf8');
  // Remove the zone block
  conf = conf.replace(new RegExp(`\\nzone\\s+"${domain.replace('.', '\\.')}"\\s*\\{[^}]*\\};\\n?`, 'gi'), '');
  fs.writeFileSync(NAMED_CONF, conf);
}

// ── Create a brand-new zone with standard records ─────────────────────────────
function createZone(domain, ip) {
  ip = ip || SERVER_IP;
  const serial = `${todaySerial()}01`;
  const records = [
    { name: `${domain}.`, ttl: DEFAULT_TTL, type: 'A',     value: ip },
    { name: 'www',         ttl: DEFAULT_TTL, type: 'CNAME', value: `${domain}.` },
    { name: 'mail',        ttl: DEFAULT_TTL, type: 'A',     value: ip },
    { name: 'panel',       ttl: DEFAULT_TTL, type: 'A',     value: ip },
    { name: `${domain}.`, ttl: DEFAULT_TTL, type: 'MX',    priority: 10, value: `mail.${domain}.` },
    { name: `${domain}.`, ttl: DEFAULT_TTL, type: 'TXT',   value: `v=spf1 ip4:${ip} a mx ~all` },
    { name: '_dmarc',      ttl: DEFAULT_TTL, type: 'TXT',   value: `v=DMARC1; p=quarantine; rua=mailto:admin@${domain}` },
  ];

  const zoneText = renderZone(domain, serial, records);
  fs.writeFileSync(zonePath(domain), zoneText);
  fs.chmodSync(zonePath(domain), 0o644);

  registerZone(domain);
  reloadBind();
  return { serial, records };
}

// ── Delete a zone entirely ────────────────────────────────────────────────────
function deleteZone(domain) {
  const file = zonePath(domain);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  unregisterZone(domain);
  reloadBind();
}

// ── Add or replace a record ───────────────────────────────────────────────────
// record: { name, ttl, type, value, priority? }
function addRecord(domain, record) {
  const zone = parseZone(domain);
  const serial = nextSerial(zone.serial);

  // For A/CNAME/AAAA: replace existing same name+type
  // For MX/TXT: allow multiples (but filter exact duplicates)
  const normalized = record.type.toUpperCase();
  let records = zone.records.filter(r => {
    if (r.name === record.name && r.type === normalized) {
      if (['MX', 'TXT', 'SRV'].includes(normalized)) {
        // Remove exact value duplicates only
        return r.value !== record.value;
      }
      // For A/CNAME/AAAA/NS: remove all existing same-name-type
      return false;
    }
    return true;
  });

  records.push({ ...record, type: normalized });
  fs.writeFileSync(zonePath(domain), renderZone(domain, serial, records));
  reloadBind();
  return { serial, records };
}

// ── Delete a specific record ──────────────────────────────────────────────────
function deleteRecord(domain, { name, type, value }) {
  const zone = parseZone(domain);
  const serial = nextSerial(zone.serial);
  const typU = type.toUpperCase();
  const records = zone.records.filter(r => {
    if (r.name === name && r.type === typU) {
      if (value) return r.value !== value;
      return false;
    }
    return true;
  });
  fs.writeFileSync(zonePath(domain), renderZone(domain, serial, records));
  reloadBind();
  return { serial, records };
}

// ── Auto-configure mail DNS for a domain ──────────────────────────────────────
// Called when first mail account for a domain is created
function setupMailDns(domain) {
  if (!zoneExists(domain)) return false; // no zone — skip silently

  const zone = parseZone(domain);
  const serial = nextSerial(zone.serial);

  // Remove old mail-related records so we can replace cleanly
  // (TXT values are stored without outer quotes in our parsed format)
  let records = zone.records.filter(r => {
    if (r.name === 'mail'    && r.type === 'A') return false;
    if (r.name === 'webmail' && r.type === 'A') return false;
    if (r.name === `${domain}.` && r.type === 'MX') return false;
    if (r.name === `${domain}.` && r.type === 'TXT' &&
        (r.value.includes('v=spf1') || r.value.includes('v=DMARC1'))) return false;
    if (r.name === '_dmarc' && r.type === 'TXT') return false;
    return true;
  });

  // Add fresh mail records (webmail A lets users reach webmail.<domain> directly)
  records = records.concat([
    { name: 'mail',        ttl: DEFAULT_TTL, type: 'A',   value: SERVER_IP },
    { name: 'webmail',     ttl: DEFAULT_TTL, type: 'A',   value: SERVER_IP },
    { name: `${domain}.`, ttl: DEFAULT_TTL, type: 'MX',  priority: 10, value: `mail.${domain}.` },
    { name: `${domain}.`, ttl: DEFAULT_TTL, type: 'TXT', value: `v=spf1 ip4:${SERVER_IP} a mx ~all` },
    { name: '_dmarc',      ttl: DEFAULT_TTL, type: 'TXT', value: `v=DMARC1; p=quarantine; rua=mailto:admin@${domain}` },
  ]);

  fs.writeFileSync(zonePath(domain), renderZone(domain, serial, records));
  reloadBind();
  return true;
}

// ── Add DKIM TXT record ────────────────────────────────────────────────────────
// dkimPublicKey: bare base64 key (no header/footer, no spaces)
function addDkimRecord(domain, dkimPublicKey, selector = 'default') {
  if (!zoneExists(domain)) return false;
  const recordName = `${selector}._domainkey`;
  const recordValue = `v=DKIM1; k=rsa; p=${dkimPublicKey}`;
  addRecord(domain, { name: recordName, ttl: DEFAULT_TTL, type: 'TXT', value: recordValue });
  return true;
}

// ── Get all records for a zone (for API) ─────────────────────────────────────
function getRecords(domain) {
  return parseZone(domain);
}

module.exports = {
  listZones,
  zoneExists,
  createZone,
  deleteZone,
  getRecords,
  addRecord,
  deleteRecord,
  setupMailDns,
  addDkimRecord,
  reloadBind,
  SERVER_IP,
  NS1,
  NS2,
};
