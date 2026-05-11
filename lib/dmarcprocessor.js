'use strict';
/**
 * lib/dmarcprocessor.js — DMARC aggregate report ingestion.
 *
 * Receiving MTAs send daily XML reports to whatever rua= mailbox you
 * published. We read that mailbox via IMAP, decompress (.gz or .zip via
 * shell `funzip` fallback) or accept raw .xml, parse the XML by
 * regex (the schema is small and stable per RFC 7489), and store
 * one row per report in dpanel_dmarc_reports.
 *
 * Config: env vars in /opt/dpanel/.env
 *   DMARC_INBOX_EMAIL    — mailbox to read (typically dmarc@<panel-domain>)
 *   DMARC_INBOX_PASSWORD — that mailbox's IMAP password
 *
 * If unset, the cron logs a one-line warning and returns. No crash.
 *
 * Doesn't depend on the heavy mailparser — pulls raw RFC822 source via
 * ImapFlow and extracts attachments via tiny MIME walking. (mailparser
 * works too but adds 1.5MB to load time on every server start.)
 */

const zlib   = require('zlib');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { pool } = require('./db');

const DMARC_FILENAME_RX = /\.(xml|xml\.gz|gz|zip)$/i;

// ── XML parser (minimal, regex-based, schema-specific) ────────────────────────

function _xText(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? m[1].trim() : null;
}
function _xNum(xml, tag) {
  const t = _xText(xml, tag);
  if (t === null) return null;
  const n = parseInt(t, 10);
  return Number.isFinite(n) ? n : null;
}

function parseReportXml(xml) {
  if (typeof xml !== 'string' || !xml.includes('<feedback')) {
    throw new Error('Not a DMARC report XML (no <feedback> root)');
  }
  const meta   = _xText(xml, 'report_metadata') || '';
  const policy = _xText(xml, 'policy_published') || '';

  const dateRange = _xText(xml, 'date_range') || '';
  const begin = _xNum(dateRange, 'begin');
  const end   = _xNum(dateRange, 'end');

  const result = {
    org_name:   _xText(meta, 'org_name'),
    email:      _xText(meta, 'email'),
    report_id:  _xText(meta, 'report_id'),
    domain:     _xText(policy, 'domain'),
    date_begin: begin ? new Date(begin * 1000) : null,
    date_end:   end   ? new Date(end   * 1000) : null,
    records:    [],
  };

  // Walk every <record>...</record>
  const recordRx = /<record\b[\s\S]*?<\/record>/g;
  let m;
  while ((m = recordRx.exec(xml)) !== null) {
    const rec        = m[0];
    const row        = _xText(rec, 'row') || '';
    const evaluated  = _xText(row, 'policy_evaluated') || '';
    const auth       = _xText(rec, 'auth_results') || '';
    const dkimBlock  = _xText(auth, 'dkim') || '';
    const spfBlock   = _xText(auth, 'spf')  || '';
    result.records.push({
      source_ip:  _xText(row, 'source_ip'),
      count:      _xNum(row, 'count') || 0,
      disposition: _xText(evaluated, 'disposition'),
      dkim_eval:  _xText(evaluated, 'dkim'),
      spf_eval:   _xText(evaluated, 'spf'),
      dkim_auth:  _xText(dkimBlock, 'result'),
      spf_auth:   _xText(spfBlock,  'result'),
      header_from: _xText(_xText(rec, 'identifiers') || '', 'header_from'),
    });
  }
  return result;
}

// ── Decompression for attachments ─────────────────────────────────────────────

function _decompressAttachment(buffer, filename) {
  const lower = (filename || '').toLowerCase();
  if (lower.endsWith('.xml.gz') || lower.endsWith('.gz')) {
    return zlib.gunzipSync(buffer).toString('utf8');
  }
  if (lower.endsWith('.zip')) {
    // Lightweight zip decode: the report XML is the first (only) file. Find
    // the local file header, locate compression method (8=deflate, 0=stored),
    // and inflate accordingly. Skip if anything looks off — caller will log.
    if (buffer.readUInt32LE(0) !== 0x04034b50) throw new Error('Not a valid zip');
    const method  = buffer.readUInt16LE(8);
    const nameLen = buffer.readUInt16LE(26);
    const extra   = buffer.readUInt16LE(28);
    const compSize = buffer.readUInt32LE(18);
    const offset   = 30 + nameLen + extra;
    const data     = buffer.slice(offset, offset + compSize);
    if (method === 0) return data.toString('utf8');             // stored
    if (method === 8) return zlib.inflateRawSync(data).toString('utf8');  // deflate
    throw new Error(`Unsupported zip compression method ${method}`);
  }
  // assume raw XML
  return buffer.toString('utf8');
}

// ── Mailbox poll ──────────────────────────────────────────────────────────────

async function _ingestReport(parsed) {
  if (!parsed.domain || !parsed.date_end) {
    throw new Error('Report missing domain or date_end — skipping');
  }
  const totals = parsed.records.reduce(
    (acc, r) => {
      acc.total += r.count;
      // "pass" = both DKIM and SPF evaluated to pass — strict DMARC alignment
      if (r.dkim_eval === 'pass' && r.spf_eval === 'pass') acc.pass += r.count;
      else acc.fail += r.count;
      return acc;
    },
    { total: 0, pass: 0, fail: 0 }
  );
  // ON DUPLICATE KEY UPDATE: same report sent twice (e.g. retries) just
  // overwrites — uniqueness is (org_name, report_id).
  await pool.query(
    `INSERT INTO dpanel_dmarc_reports
      (org_name, report_id, domain, date_begin, date_end, total_count, pass_count, fail_count, records_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        date_begin = VALUES(date_begin),
        date_end   = VALUES(date_end),
        total_count = VALUES(total_count),
        pass_count  = VALUES(pass_count),
        fail_count  = VALUES(fail_count),
        records_json = VALUES(records_json),
        ingested_at = NOW()`,
    [
      parsed.org_name, parsed.report_id, parsed.domain,
      parsed.date_begin, parsed.date_end,
      totals.total, totals.pass, totals.fail,
      JSON.stringify(parsed.records),
    ]
  );
}

/**
 * Connect to the configured DMARC inbox, process unseen messages, mark
 * them seen. Returns a summary of what happened so the cron can log it.
 */
async function processInbox() {
  const email = process.env.DMARC_INBOX_EMAIL;
  const pass  = process.env.DMARC_INBOX_PASSWORD;
  if (!email || !pass) {
    return { configured: false, reason: 'DMARC_INBOX_EMAIL / DMARC_INBOX_PASSWORD not set in /opt/dpanel/.env' };
  }
  const summary = { configured: true, messages: 0, reports: 0, errors: [] };
  const client = new ImapFlow({
    host:   '127.0.0.1',
    port:   993,
    secure: true,
    auth:   { user: email, pass },
    tls:    { rejectUnauthorized: false },
    logger: false,
  });
  await client.connect();
  try {
    await client.mailboxOpen('INBOX');
    const uids = await client.search({ seen: false });
    for (const uid of (uids || [])) {
      summary.messages++;
      try {
        const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
        if (!msg) continue;
        const parsed = await simpleParser(msg.source);
        for (const att of (parsed.attachments || [])) {
          const fn = (att.filename || '').toLowerCase();
          if (!DMARC_FILENAME_RX.test(fn)) continue;
          try {
            const xml = _decompressAttachment(att.content, fn);
            const report = parseReportXml(xml);
            await _ingestReport(report);
            summary.reports++;
          } catch (err) {
            summary.errors.push(`${fn}: ${err.message}`);
          }
        }
        await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
      } catch (err) {
        summary.errors.push(`uid=${uid}: ${err.message}`);
      }
    }
  } finally {
    await client.logout();
  }
  return summary;
}

/**
 * Recent reports for the UI. Latest first, capped.
 */
async function recentReports(limit = 30) {
  const cap = Math.min(Math.max(parseInt(limit, 10) || 30, 1), 200);
  const [rows] = await pool.query(
    `SELECT id, org_name, domain, date_begin, date_end, total_count, pass_count, fail_count, ingested_at
       FROM dpanel_dmarc_reports
       ORDER BY date_end DESC
       LIMIT ?`,
    [cap]
  );
  return rows;
}

module.exports = { parseReportXml, processInbox, recentReports };
