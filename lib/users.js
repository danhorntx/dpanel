'use strict';
const bcrypt = require('bcryptjs');
const { pool } = require('./db');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function validateEmail(email) {
  if (email === null || email === undefined || email === '') return null;
  const trimmed = String(email).trim();
  if (!EMAIL_RE.test(trimmed)) throw new Error('Invalid email address');
  if (trimmed.length > 320)    throw new Error('Email too long (max 320 chars)');
  return trimmed;
}

async function listUsers() {
  const [users] = await pool.query(
    `SELECT u.id, u.username, u.email, u.role, u.created_at,
            GROUP_CONCAT(ud.domain ORDER BY ud.domain SEPARATOR ',') AS domains
     FROM dpanel_users u
     LEFT JOIN dpanel_user_domains ud ON ud.user_id = u.id
     GROUP BY u.id
     ORDER BY u.role, u.username`
  );
  return users.map(u => ({
    id:         u.id,
    username:   u.username,
    email:      u.email,
    role:       u.role,
    created_at: u.created_at,
    domains:    u.domains ? u.domains.split(',') : [],
  }));
}

async function getUser(id) {
  const [[user]] = await pool.query(
    'SELECT id, username, email, role, created_at FROM dpanel_users WHERE id = ?', [id]
  );
  if (!user) return null;
  const [rows] = await pool.query(
    'SELECT domain FROM dpanel_user_domains WHERE user_id = ? ORDER BY domain', [id]
  );
  user.domains = rows.map(r => r.domain);
  return user;
}

async function createUser({ username, password, email, role = 'user', domains = [] }) {
  if (!username || !password) throw new Error('Username and password required');
  const normalizedEmail = validateEmail(email);
  const hash = await bcrypt.hash(password, 12);
  const [res] = await pool.query(
    'INSERT INTO dpanel_users (username, password_hash, email, role) VALUES (?, ?, ?, ?)',
    [username, hash, normalizedEmail, role]
  );
  const userId = res.insertId;
  if (domains.length) {
    const vals = domains.map(d => [userId, d]);
    await pool.query('INSERT INTO dpanel_user_domains (user_id, domain) VALUES ?', [vals]);
  }
  return userId;
}

async function updateUser(id, { password, email, role, domains }) {
  if (password) {
    const hash = await bcrypt.hash(password, 12);
    await pool.query('UPDATE dpanel_users SET password_hash = ? WHERE id = ?', [hash, id]);
  }
  if (email !== undefined) {
    const normalizedEmail = validateEmail(email);
    await pool.query('UPDATE dpanel_users SET email = ? WHERE id = ?', [normalizedEmail, id]);
  }
  if (role) {
    await pool.query('UPDATE dpanel_users SET role = ? WHERE id = ?', [role, id]);
  }
  if (domains !== undefined) {
    await pool.query('DELETE FROM dpanel_user_domains WHERE user_id = ?', [id]);
    if (domains.length) {
      const vals = domains.map(d => [id, d]);
      await pool.query('INSERT INTO dpanel_user_domains (user_id, domain) VALUES ?', [vals]);
    }
  }
}

async function deleteUser(id) {
  await pool.query('DELETE FROM dpanel_users WHERE id = ?', [id]);
}

/**
 * Returns the panel's canonical contact email — first admin user's email,
 * or null if none has one set. Used by Let's Encrypt registration, future
 * notification system. Callers fall back to a per-domain placeholder when null.
 */
async function getAdminEmail() {
  const [[row]] = await pool.query(
    `SELECT email FROM dpanel_users
     WHERE role = 'admin' AND email IS NOT NULL AND email <> ''
     ORDER BY id LIMIT 1`
  );
  return row?.email || null;
}

module.exports = { listUsers, getUser, createUser, updateUser, deleteUser, getAdminEmail };
