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
const { logAction } = require('./shell');

// ── Constants ─────────────────────────────────────────────────────────────────
const ZONE_DIR      = '/var/lib/bind';
const NAMED_CONF    = '/etc/bind/named.conf.local';
// Nameserver pair stamped into every zone's SOA MNAME + NS RRset.
//
// These MUST match the delegation the registrar publishes for the zones this
// host is authoritative for — a resolver that prefers the child NS RRset over
// the parent delegation will otherwise start asking a host that doesn't serve
// the zone, which fails intermittently rather than cleanly. Same override
// pattern as DPANEL_SERVER_IP below: the defaults are prod's vanity NS, and a
// second host (staging) sets DPANEL_NS1/DPANEL_NS2 in .env to its own pair.
const NS1           = process.env.DPANEL_NS1 || 'ns1.danhorntx.com';
const NS2           = process.env.DPANEL_NS2 || 'ns2.danhorntx.com';
const DEFAULT_TTL   = 14400;
const SOA_TTL       = 86400;

// ── SERVER_IP: detect at module load, allow env override ──────────────────────
// Previously hardcoded to the prod IP — that was fine until DPanel ran on a
// second host (staging) and started writing prod's IP into staging's DNS
// records, breaking ACME validation for every mail-related subdomain.
//
// Resolution order:
//   1. process.env.DPANEL_SERVER_IP — explicit operator override (set in .env)
//   2. `hostname -I | awk '{print $1}'` — usually returns the primary public
//      IPv4. Quick and works on every Linux distro we run on.
//   3. '127.0.0.1' — last-ditch fallback so the module loads at all; will
//      produce obviously-wrong DNS records the operator will notice.
function _detectServerIp() {
  if (process.env.DPANEL_SERVER_IP) return process.env.DPANEL_SERVER_IP;
  try {
    const ip = execSync("hostname -I | awk '{print $1}'", { encoding: 'utf8', timeout: 2000 }).trim();
    if (ip && /^[0-9.]+$/.test(ip)) return ip;
  } catch (_) {}
  return '127.0.0.1';
}
const SERVER_IP = _detectServerIp();

// Types whose trailing dot renderZone puts back. Only these may have it
// stripped at parse time — anything else must round-trip verbatim.
const DOTTED_TYPES = new Set(['CNAME', 'MX']);

// Does this owner name refer to the zone apex? Zone files DPanel writes use
// the fully-qualified form; hand-edited ones may use '@' or the bare name.
function _isApexName(name, domain) {
  return name === `${domain}.` || name === domain || name === '@';
}

// ── Serial helpers ────────────────────────────────────────────────────────────
function todaySerial() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

// Advance to the next date prefix with NN=01. Guarantees a strictly larger
// serial that is still 10 digits, which is what the uint32 SOA serial field
// and parseZone's 10-digit reader both require.
function _rollSerialForward(curStr) {
  const y = Number(curStr.slice(0, 4));
  const m = Number(curStr.slice(4, 6));
  const d = Number(curStr.slice(6, 8));
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  const p = `${next.getUTCFullYear()}` +
            `${String(next.getUTCMonth() + 1).padStart(2, '0')}` +
            `${String(next.getUTCDate()).padStart(2, '0')}`;
  return `${p}01`;
}

// A zone serial must increase on every write, or secondaries stop transferring.
// The YYYYMMDDNN scheme only has room for 99 edits per day; the 100th used to
// produce an 11-digit serial, which overflows the uint32 SOA serial field AND
// fails parseZone's 10-digit reader — so the following write read it back as 0
// and went *backwards*. Roll the date prefix forward instead: still 10 digits,
// still strictly increasing, self-corrects once the calendar catches up.
function nextSerial(current) {
  const prefix = todaySerial();
  const curStr = String(current || '0');

  if (curStr.startsWith(prefix)) {
    const nn = parseInt(curStr.slice(8), 10) + 1;
    if (nn <= 99) return `${prefix}${String(nn).padStart(2, '0')}`;
    console.warn(`[dns] serial ${curStr} exhausted today's 99 revisions — rolling prefix forward`);
    return _ensureIncreasing(_rollSerialForward(curStr), curStr);
  }

  // Different day (or unreadable serial). Today's prefix normally wins, but
  // never hand back something smaller than what is already on disk.
  const candidate = `${prefix}01`;
  return _ensureIncreasing(candidate, curStr);
}

// Guarantee the serial we return is larger than the one on disk. A zone whose
// serial goes backwards stops transferring to secondaries, which is the worst
// failure this module can cause, so this is belt-and-braces on every path.
function _ensureIncreasing(candidate, curStr) {
  const cur = Number(curStr);
  if (Number(candidate) > cur) return candidate;

  const rolled = _rollSerialForward(curStr);
  if (Number(rolled) > cur && Number(rolled) <= 4294967295) return rolled;

  // Date-based schemes can't beat a serial that is already past them (only
  // reachable if something wrote a serial by hand). Plain increment keeps the
  // guarantee for as long as the uint32 SOA field allows.
  if (cur < 4294967295) return String(cur + 1);

  // Out of uint32 range: BIND cannot have loaded this zone (named-checkzone
  // rejects it), so there is no working serial to stay ahead of. Reset to a
  // valid one and say so loudly.
  console.warn(`[dns] serial ${curStr} exceeds the uint32 SOA field — resetting to ${candidate}`);
  return candidate;
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
    const soam = line.match(/^\s*(\d{10,})\s*;/);
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

    // Apex NS records are infrastructure — renderZone re-stamps them from
    // NS1/NS2, so they must not also round-trip as ordinary records. But
    // delegations *below* the apex (`sub  IN  NS  ns1.other.net.`) are real
    // operator data, and skipping those deleted them on the next zone write.
    if (type === 'NS' && _isApexName(name, domain)) continue;

    // Strip the trailing dot ONLY for the types renderZone puts one back on.
    // Stripping it from anything else silently rewrote the value: an SRV
    // target `sip.example.com.` came back as `sip.example.com`, which BIND
    // then resolves relative to $ORIGIN as sip.example.com.<zone>.
    if (DOTTED_TYPES.has(type)) value = value.replace(/\.$/, '');

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
        const exchange = mxm[2].trim();
        // Skip malformed MX records like "10 0 ." (invalid extra priority token).
        // A valid exchange is either '.' (null MX, RFC 7505) or a hostname with no spaces.
        if (/\s/.test(exchange)) continue;
        const mxVal = exchange === '.' ? '.' : exchange.replace(/\.$/, '');
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
    return true;
  } catch (err) {
    // rndc might fail if BIND isn't running — try restarting
    try {
      execSync('systemctl reload-or-restart named', { timeout: 15000 });
      return true;
    } catch (err2) {
      // Deliberately not rethrown: safeWriteZone has already validated and
      // written a good zone file, and turning a transient rndc hiccup into a
      // rolled-back write would be the worse failure. But this cannot stay
      // invisible — BIND is now serving stale data for this zone.
      const detail = ((err2.stderr || err2.message || '')).toString().trim().slice(0, 200);
      console.error(`[dns] BIND reload FAILED — serving stale zone data: ${detail}`);
      logAction('dns:reload-failed', 'bind', detail);
      return false;
    }
  }
}

// ── Validate zone file with named-checkzone ───────────────────────────────────
// Throws if the zone has any syntax errors, preventing a broken reload.
function validateZone(domain) {
  const file = zonePath(domain);
  try {
    execSync(`named-checkzone "${domain}" "${file}"`, { timeout: 10000, stdio: 'pipe' });
  } catch (err) {
    const output = ((err.stdout || '') + (err.stderr || '')).toString().trim();
    throw new Error(`Zone validation failed for ${domain}: ${output}`);
  }
}

// ── NS re-stamp trail ─────────────────────────────────────────────────────────
// renderZone stamps NS1/NS2 into the SOA MNAME + NS RRset on EVERY write, so an
// unrelated record edit (adding an A record, a DKIM key, mail setup) silently
// re-delegates the zone whenever this host's NS pair differs from what is on
// disk — e.g. the first edit after a host sets DPANEL_NS1/DPANEL_NS2. That is
// intended behaviour (each host must advertise its own NS), but it must leave a
// trail: a child NS RRset that disagrees with the registrar's delegation fails
// intermittently rather than cleanly, and is miserable to trace after the fact.
function _logNsRestamp(domain, file) {
  try {
    const before = [];
    for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = raw.match(/^(\S+)\s+(?:\d+\s+)?IN\s+NS\s+(\S+)\s*$/i);
      if (m && _isApexName(m[1], domain)) before.push(m[2].replace(/\.$/, ''));
    }
    if (!before.length) return;                       // nothing to compare against
    const after = [NS1, NS2];
    if (before.length === after.length && before.every((ns, i) => ns === after[i])) return;
    const msg = `apex NS for ${domain} re-stamped: ${before.join(' + ')} -> ${after.join(' + ')}`;
    console.warn(`[dns] ${msg}`);
    logAction('dns:ns-restamp', domain, msg);
  } catch (_) { /* advisory only — never block a zone write on logging */ }
}

// ── Safe zone write: validate before reload, restore backup on failure ────────
// All zone mutations go through this instead of bare fs.writeFileSync + reloadBind.
function safeWriteZone(domain, serial, records) {
  const file   = zonePath(domain);
  const backup = file + '.bak';

  // Snapshot existing zone so we can roll back if the new one fails validation
  const hadExisting = fs.existsSync(file);
  if (hadExisting) {
    _logNsRestamp(domain, file);   // before we overwrite it
    fs.copyFileSync(file, backup);
  }

  try {
    fs.writeFileSync(file, renderZone(domain, serial, records));
    fs.chmodSync(file, 0o644);
    validateZone(domain);   // throws on any BIND syntax error
    reloadBind();
    if (fs.existsSync(backup)) fs.unlinkSync(backup);
  } catch (err) {
    // Restore the previous good zone so BIND keeps serving valid DNS
    if (hadExisting && fs.existsSync(backup)) {
      fs.copyFileSync(backup, file);
      fs.unlinkSync(backup);
    } else if (!hadExisting && fs.existsSync(file)) {
      fs.unlinkSync(file);   // new zone that was never valid — remove it
    }
    throw err;
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
    // NOTE: no panel.<domain> record — the panel is only served at its own
    // hostname on each host; stamping panel.<clientdomain> into every zone
    // left 13 dead records pointing at an unserved name (cleaned 2026-08-13).
    { name: `${domain}.`, ttl: DEFAULT_TTL, type: 'MX',    priority: 10, value: `mail.${domain}.` },
    { name: `${domain}.`, ttl: DEFAULT_TTL, type: 'TXT',   value: `v=spf1 ip4:${ip} a mx ~all` },
    { name: '_dmarc',      ttl: DEFAULT_TTL, type: 'TXT',   value: `v=DMARC1; p=quarantine; rua=mailto:admin@${domain}` },
  ];

  registerZone(domain);
  safeWriteZone(domain, serial, records);
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
  safeWriteZone(domain, serial, records);
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
  safeWriteZone(domain, serial, records);
  return { serial, records };
}

// ── Zone resolution: find the zone + relative prefix for a mail domain ───────
// Apex case  (mailDomain = "example.com", we manage example.com's zone)
//   → { zone: "example.com", prefix: "" }
// Subdomain  (mailDomain = "app.example.com", we manage example.com's zone)
//   → { zone: "example.com", prefix: "app" }
// Unmanaged  (no zone for mailDomain or any ancestor)
//   → { zone: null, prefix: null }
function _resolveZoneAndPrefix(mailDomain) {
  if (zoneExists(mailDomain)) return { zone: mailDomain, prefix: '' };
  const parts = mailDomain.split('.');
  for (let i = 1; i < parts.length - 1; i++) {
    const candidate = parts.slice(i).join('.');
    if (zoneExists(candidate)) {
      return { zone: candidate, prefix: parts.slice(0, i).join('.') };
    }
  }
  return { zone: null, prefix: null };
}

// Build a relative record name: prefixed by `prefix.` if we're in a parent zone,
// otherwise just the base name. E.g. mailRelName('mail', '') === 'mail',
// mailRelName('mail', 'app') === 'mail.app'.
function _relName(base, prefix) {
  return prefix ? `${base}.${prefix}` : base;
}

// ── Auto-configure mail DNS for a domain ──────────────────────────────────────
// Called when first mail account for a domain is created.
//
// Writes the full set of records needed for modern deliverability:
//   • mail A, webmail A, mta-sts A    → SERVER_IP
//   • MX 10 mail.<domain>
//   • SPF (v=spf1 ip4:SERVER_IP a mx ~all)
//   • DMARC v1 (p=quarantine)
//   • TLS-RPT v1 (RFC 8460 — receivers can report TLS failures)
//   • _mta-sts v1 with a date-based id (RFC 8461 policy advertisement)
//
// Handles both apex domains AND subdomains whose parent we manage. For a
// subdomain, all records are written into the parent zone under the
// appropriate relative names (mail.<prefix>, _dmarc.<prefix>, etc.) and
// the MX/SPF live at the subdomain's apex written as FQDNs with trailing dots.
function setupMailDns(mailDomain) {
  const { zone, prefix } = _resolveZoneAndPrefix(mailDomain);
  if (!zone) return false; // no managed zone — skip silently

  const parsed = parseZone(zone);
  const serial = nextSerial(parsed.serial);
  const mtaStsId = new Date().toISOString().slice(0, 10).replace(/-/g, '');

  const mailRel    = _relName('mail',       prefix);
  const webmailRel = _relName('webmail',    prefix);
  const mtaStsRel  = _relName('mta-sts',    prefix);
  const dmarcRel   = _relName('_dmarc',     prefix);
  const stsTxtRel  = _relName('_mta-sts',   prefix);
  const tlsRptRel  = _relName('_smtp._tls', prefix);
  const apexFqdn   = `${mailDomain}.`;  // works for both apex and subdomain

  // Remove old mail-related records so we can replace cleanly
  let records = parsed.records.filter(r => {
    if (r.name === mailRel    && r.type === 'A') return false;
    if (r.name === webmailRel && r.type === 'A') return false;
    if (r.name === mtaStsRel  && r.type === 'A') return false;
    if (r.name === apexFqdn   && r.type === 'MX') return false;
    if (r.name === apexFqdn   && r.type === 'TXT' &&
        (r.value.includes('v=spf1') || r.value.includes('v=DMARC1'))) return false;
    if (r.name === dmarcRel   && r.type === 'TXT') return false;
    if (r.name === stsTxtRel  && r.type === 'TXT') return false;
    if (r.name === tlsRptRel  && r.type === 'TXT') return false;
    return true;
  });

  records = records.concat([
    { name: mailRel,    ttl: DEFAULT_TTL, type: 'A',   value: SERVER_IP },
    { name: webmailRel, ttl: DEFAULT_TTL, type: 'A',   value: SERVER_IP },
    { name: mtaStsRel,  ttl: DEFAULT_TTL, type: 'A',   value: SERVER_IP },
    { name: apexFqdn,   ttl: DEFAULT_TTL, type: 'MX',  priority: 10, value: `mail.${mailDomain}.` },
    { name: apexFqdn,   ttl: DEFAULT_TTL, type: 'TXT', value: `v=spf1 ip4:${SERVER_IP} a mx ~all` },
    { name: dmarcRel,   ttl: DEFAULT_TTL, type: 'TXT', value: `v=DMARC1; p=quarantine; rua=mailto:admin@${mailDomain}` },
    { name: stsTxtRel,  ttl: DEFAULT_TTL, type: 'TXT', value: `v=STSv1; id=${mtaStsId}` },
    { name: tlsRptRel,  ttl: DEFAULT_TTL, type: 'TXT', value: `v=TLSRPTv1; rua=mailto:admin@${mailDomain}` },
  ]);

  safeWriteZone(zone, serial, records);
  return true;
}

// ── Add DKIM TXT record ────────────────────────────────────────────────────────
// dkimPublicKey: bare base64 key (no header/footer, no spaces).
// Handles both apex (`example.com` → record in `example.com`'s zone at
// `mail._domainkey`) and subdomains (`app.example.com` → record in
// `example.com`'s zone at `mail._domainkey.app`).
function addDkimRecord(mailDomain, dkimPublicKey, selector = 'default') {
  const { zone, prefix } = _resolveZoneAndPrefix(mailDomain);
  if (!zone) return false;
  const recordName  = _relName(`${selector}._domainkey`, prefix);
  const recordValue = `v=DKIM1; k=rsa; p=${dkimPublicKey}`;
  addRecord(zone, { name: recordName, ttl: DEFAULT_TTL, type: 'TXT', value: recordValue });
  return true;
}

// Companion: remove an existing DKIM record (used when re-publishing, and
// when destroying the domain). No-op if not found.
function removeDkimRecord(mailDomain, selector = 'default') {
  const { zone, prefix } = _resolveZoneAndPrefix(mailDomain);
  if (!zone) return false;
  const recordName = _relName(`${selector}._domainkey`, prefix);
  try { deleteRecord(zone, { name: recordName, type: 'TXT' }); } catch (_) { return false; }
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
  removeDkimRecord,
  resolveZoneAndPrefix: _resolveZoneAndPrefix,
  reloadBind,
  SERVER_IP,
  NS1,
  NS2,
};
