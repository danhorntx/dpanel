'use strict';
const mysql = require('mysql2/promise');
const fs    = require('fs');
const path  = require('path');
const bcrypt = require('bcryptjs');

const CONFIG_FILE = path.join(__dirname, '..', 'config.json');

// ── Connection pool ───────────────────────────────────────────────────────────
const pool = mysql.createPool({
  host:            process.env.DB_HOST     || '127.0.0.1',
  port:            process.env.DB_PORT     || 3306,
  user:            process.env.DB_USER     || 'dpanel',
  password:        process.env.DB_PASSWORD || 'dpanel_db_secret_2024',
  database:        'dpanel',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit:      0,
  timezone:        'Z',
});

// ── Schema migration (idempotent) ─────────────────────────────────────────────
async function migrate() {
  const conn = await pool.getConnection();
  try {
    // Users table
    await conn.query(`
      CREATE TABLE IF NOT EXISTS dpanel_users (
        id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        username      VARCHAR(64)  NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        role          ENUM('admin','user') NOT NULL DEFAULT 'user',
        created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Domain assignments (many:many — users ↔ domains)
    await conn.query(`
      CREATE TABLE IF NOT EXISTS dpanel_user_domains (
        user_id   INT UNSIGNED NOT NULL,
        domain    VARCHAR(253) NOT NULL,
        PRIMARY KEY (user_id, domain),
        FOREIGN KEY (user_id) REFERENCES dpanel_users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Audit log
    await conn.query(`
      CREATE TABLE IF NOT EXISTS dpanel_audit_log (
        id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        user_id    INT UNSIGNED,
        username   VARCHAR(64),
        action     VARCHAR(128) NOT NULL,
        target     VARCHAR(253),
        detail     TEXT,
        ip         VARCHAR(45),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX (user_id),
        INDEX (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // ── Migrate from config.json if no users exist yet ─────────────────────────
    const [rows] = await conn.query('SELECT COUNT(*) AS cnt FROM dpanel_users');
    if (rows[0].cnt === 0 && fs.existsSync(CONFIG_FILE)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        if (cfg.username && cfg.passwordHash) {
          await conn.query(
            'INSERT INTO dpanel_users (username, password_hash, role) VALUES (?, ?, ?)',
            [cfg.username, cfg.passwordHash, 'admin']
          );
          console.log(`[db] Migrated admin user '${cfg.username}' from config.json`);
          // Rename so we don't re-import on next boot
          fs.renameSync(CONFIG_FILE, CONFIG_FILE + '.migrated');
          console.log('[db] config.json renamed to config.json.migrated');
        }
      } catch (err) {
        console.error('[db] Migration from config.json failed:', err.message);
      }
    }

    console.log('[db] Schema migration complete');
  } finally {
    conn.release();
  }
}

// ── Audit helper ──────────────────────────────────────────────────────────────
async function audit(userId, username, action, target, detail, ip) {
  try {
    await pool.query(
      'INSERT INTO dpanel_audit_log (user_id, username, action, target, detail, ip) VALUES (?, ?, ?, ?, ?, ?)',
      [userId || null, username || null, action, target || null, detail || null, ip || null]
    );
  } catch (_) { /* non-fatal */ }
}

module.exports = { pool, migrate, audit };
