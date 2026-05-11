'use strict';
/**
 * lib/apikey.js — API key generation + lookup helpers.
 *
 * Keys look like `dpk_<32 base62 chars>` — the `dpk_` prefix makes them
 * grep-friendly in logs and accidental commits. We never store the raw key:
 * the DB holds SHA-256(key) for lookup and a short prefix for UI display.
 *
 * One key = one row in dpanel_api_keys. Lookup is constant-time-comparable
 * via the indexed key_hash column.
 */

const crypto = require('crypto');
const { pool } = require('./db');

const BASE62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * Generate a fresh API key. Returns the raw key (show once) plus the SHA-256
 * hash and a display prefix the caller stores in the DB.
 */
function generateKey() {
  const body = Array.from(crypto.randomBytes(32))
    .map(b => BASE62[b % BASE62.length])
    .join('');
  const raw     = `dpk_${body}`;
  const hash    = crypto.createHash('sha256').update(raw).digest('hex');
  const prefix  = raw.slice(0, 12) + '…';   // "dpk_abcd1234…"
  return { raw, hash, prefix };
}

/**
 * Look up a key by its raw value. Returns the DB row (or null), with the
 * created-by user's role/username joined in for convenience.
 */
async function lookupKey(raw) {
  if (!raw || typeof raw !== 'string' || !raw.startsWith('dpk_')) return null;
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const [[row]] = await pool.query(
    `SELECT k.id, k.name, k.scope, k.expires_at, k.created_by,
            u.username, u.role
       FROM dpanel_api_keys k
       LEFT JOIN dpanel_users u ON u.id = k.created_by
      WHERE k.key_hash = ?`,
    [hash]
  );
  if (!row) return null;
  if (row.expires_at && new Date(row.expires_at) < new Date()) return null;
  return row;
}

/**
 * Update last-used timestamp + IP. Fire-and-forget — failure must not block
 * the request the key was authorizing.
 */
function touchKey(id, ip) {
  pool.query(
    'UPDATE dpanel_api_keys SET last_used_at = NOW(), last_used_ip = ? WHERE id = ?',
    [ip, id]
  ).catch(() => {});
}

/**
 * List all keys (no raw, no hash — just metadata). Newest first.
 */
async function listKeys() {
  const [rows] = await pool.query(
    `SELECT k.id, k.name, k.prefix, k.scope, k.created_at, k.last_used_at,
            k.last_used_ip, k.expires_at, u.username AS created_by_username
       FROM dpanel_api_keys k
       LEFT JOIN dpanel_users u ON u.id = k.created_by
       ORDER BY k.created_at DESC`
  );
  return rows;
}

/**
 * Create a key. Returns the raw key in the result — the ONLY chance the
 * caller has to read it.
 */
async function createKey({ name, scope = 'admin', createdBy, expiresAt = null }) {
  if (!name || typeof name !== 'string' || name.length > 128) throw new Error('Key name required (max 128 chars)');
  if (!['admin', 'read'].includes(scope))                     throw new Error('Invalid scope');
  const { raw, hash, prefix } = generateKey();
  const [res] = await pool.query(
    'INSERT INTO dpanel_api_keys (name, key_hash, prefix, scope, created_by, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    [name, hash, prefix, scope, createdBy || null, expiresAt]
  );
  return { id: res.insertId, name, prefix, scope, raw, created_at: new Date(), expires_at: expiresAt };
}

async function revokeKey(id) {
  const [res] = await pool.query('DELETE FROM dpanel_api_keys WHERE id = ?', [id]);
  return res.affectedRows > 0;
}

module.exports = { generateKey, lookupKey, touchKey, listKeys, createKey, revokeKey };
