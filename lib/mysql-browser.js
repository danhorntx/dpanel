'use strict';
/**
 * lib/mysql-browser.js — Read/write database browser, phpMyAdmin-style.
 *
 * Connects as root over the local mariadb unix socket (no password — Ubuntu's
 * default config does unix_socket auth for root). Every endpoint is gated by
 * requireAdmin in routes/mysql.js, so the whole feature is privileged.
 *
 * Why this exists as its own module: the existing lib/mysql.js shells out to
 * the `mysql` CLI and parses tab-separated output — fine for "create DB" but
 * a nightmare for "browse rows with mixed types". This module uses mysql2
 * properly and returns structured results.
 */

const mysql2 = require('mysql2/promise');

// Hard caps so a runaway query can't OOM the panel.
const MAX_ROWS_PER_QUERY = 500;
const DEFAULT_PAGE_SIZE  = 50;

// Identifier sanitizer: lets through MySQL-safe identifiers (letters, digits,
// underscore, hyphen, dot for db.table refs). Quote with backticks at use
// site to defend against the remaining edge cases.
function sanitizeId(name, label = 'identifier') {
  if (typeof name !== 'string' || !name.length) throw new Error(`${label} required`);
  if (name.length > 64) throw new Error(`${label} too long (>64 chars)`);
  if (!/^[a-zA-Z0-9_\-]+$/.test(name)) throw new Error(`${label} contains illegal characters`);
  return name;
}
function backtick(name) { return '`' + name.replace(/`/g, '``') + '`'; }

// Open + close a connection scoped to one HTTP request. Always closed in finally.
async function _withConn(database, fn) {
  // MariaDB on Ubuntu 24.04 writes its socket here:
  const conn = await mysql2.createConnection({
    socketPath: '/run/mysqld/mysqld.sock',
    user:       'root',
    database,
    multipleStatements: false,  // safer; SQL tab caller can opt-in
    dateStrings: true,          // avoid Date objects that JSON-stringify oddly
  });
  try { return await fn(conn); }
  finally { try { await conn.end(); } catch (_) {} }
}

// ── Tables ────────────────────────────────────────────────────────────────────

/**
 * List tables in a database with row count + byte size estimates from
 * information_schema. Estimates come from the storage engine and can be
 * way off for InnoDB — but they're a useful sort order, and we caveat in UI.
 */
async function listTables(database) {
  sanitizeId(database, 'database');
  return _withConn(database, async (conn) => {
    const [rows] = await conn.query(
      `SELECT
         TABLE_NAME     AS name,
         TABLE_ROWS     AS row_estimate,
         DATA_LENGTH    AS data_bytes,
         INDEX_LENGTH   AS index_bytes,
         TABLE_TYPE     AS type,
         ENGINE         AS engine
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ?
       ORDER BY TABLE_NAME`,
      [database]
    );
    return rows;
  });
}

/**
 * Describe a table: columns, indexes, basic constraints.
 */
async function describeTable(database, table) {
  sanitizeId(database, 'database');
  sanitizeId(table,    'table');
  return _withConn(database, async (conn) => {
    const [columns] = await conn.query(`SHOW FULL COLUMNS FROM ${backtick(table)}`);
    const [indexes] = await conn.query(`SHOW INDEX FROM ${backtick(table)}`);
    const [[meta]]  = await conn.query(
      `SELECT TABLE_ROWS AS row_estimate, ENGINE AS engine, CREATE_TIME AS created_at
         FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
      [database, table]
    );
    return { meta: meta || {}, columns, indexes };
  });
}

// ── Rows ──────────────────────────────────────────────────────────────────────

/**
 * Paginated SELECT against a single table.
 *
 *   limit / offset — pagination
 *   orderBy        — column name (validated against actual columns) + dir
 *   where          — optional simple "<col> = <value>" filter (parameterized);
 *                    for anything more complex the user goes to the SQL tab
 */
async function selectRows(database, table, opts = {}) {
  sanitizeId(database, 'database');
  sanitizeId(table,    'table');
  const limit  = Math.min(Math.max(parseInt(opts.limit  || DEFAULT_PAGE_SIZE, 10), 1), MAX_ROWS_PER_QUERY);
  const offset = Math.max(parseInt(opts.offset || 0, 10), 0);

  return _withConn(database, async (conn) => {
    // Fetch columns first — we use it to validate orderBy / where column refs
    // before they go anywhere near SQL.
    const [colRows] = await conn.query(`SHOW COLUMNS FROM ${backtick(table)}`);
    const colNames  = colRows.map(c => c.Field);

    let orderClause = '';
    if (opts.orderBy && colNames.includes(opts.orderBy)) {
      const dir = (opts.orderDir || 'ASC').toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
      orderClause = ` ORDER BY ${backtick(opts.orderBy)} ${dir}`;
    }

    let whereClause = '';
    const params = [];
    if (opts.whereCol && opts.whereVal !== undefined && colNames.includes(opts.whereCol)) {
      whereClause = ` WHERE ${backtick(opts.whereCol)} = ?`;
      params.push(opts.whereVal);
    }

    const [[{ total }]] = await conn.query(
      `SELECT COUNT(*) AS total FROM ${backtick(table)}${whereClause}`, params
    );
    const [rows] = await conn.query(
      `SELECT * FROM ${backtick(table)}${whereClause}${orderClause} LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    return {
      columns: colNames,
      column_types: colRows.map(c => ({ name: c.Field, type: c.Type, null: c.Null, key: c.Key })),
      rows,
      total,
      limit,
      offset,
    };
  });
}

// ── Arbitrary SQL ─────────────────────────────────────────────────────────────

/**
 * Run a free-form SQL statement. Result is capped to MAX_ROWS_PER_QUERY.
 * Admin-only at the route layer — this function does NOT itself enforce auth.
 *
 * Returns:
 *   { columns: [...], rows: [...], affectedRows, executionMs, warnings? }
 */
async function executeQuery(database, query) {
  sanitizeId(database, 'database');
  if (typeof query !== 'string' || !query.trim()) throw new Error('Query is empty');
  if (query.length > 65536) throw new Error('Query too long (>64 KB)');

  return _withConn(database, async (conn) => {
    const t0 = Date.now();
    const [result, fields] = await conn.query(query);
    const executionMs = Date.now() - t0;

    // mysql2 returns either an array of rows (SELECT) or a result-meta object
    // (INSERT/UPDATE/DELETE/DDL). Normalize.
    if (Array.isArray(result)) {
      const rows = result.slice(0, MAX_ROWS_PER_QUERY);
      const truncated = result.length > MAX_ROWS_PER_QUERY;
      return {
        kind:    'rows',
        columns: fields ? fields.map(f => f.name) : (rows[0] ? Object.keys(rows[0]) : []),
        rows,
        rowCount: result.length,
        truncated,
        executionMs,
      };
    }
    return {
      kind:         'meta',
      affectedRows: result.affectedRows,
      insertId:     result.insertId,
      info:         result.info,
      executionMs,
    };
  });
}

module.exports = { listTables, describeTable, selectRows, executeQuery };
