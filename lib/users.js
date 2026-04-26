'use strict';
const bcrypt = require('bcryptjs');
const { pool } = require('./db');

async function listUsers() {
  const [users] = await pool.query(
    `SELECT u.id, u.username, u.role, u.created_at,
            GROUP_CONCAT(ud.domain ORDER BY ud.domain SEPARATOR ',') AS domains
     FROM dpanel_users u
     LEFT JOIN dpanel_user_domains ud ON ud.user_id = u.id
     GROUP BY u.id
     ORDER BY u.role, u.username`
  );
  return users.map(u => ({
    id:         u.id,
    username:   u.username,
    role:       u.role,
    created_at: u.created_at,
    domains:    u.domains ? u.domains.split(',') : [],
  }));
}

async function getUser(id) {
  const [[user]] = await pool.query(
    'SELECT id, username, role, created_at FROM dpanel_users WHERE id = ?', [id]
  );
  if (!user) return null;
  const [rows] = await pool.query(
    'SELECT domain FROM dpanel_user_domains WHERE user_id = ? ORDER BY domain', [id]
  );
  user.domains = rows.map(r => r.domain);
  return user;
}

async function createUser({ username, password, role = 'user', domains = [] }) {
  if (!username || !password) throw new Error('Username and password required');
  const hash = await bcrypt.hash(password, 12);
  const [res] = await pool.query(
    'INSERT INTO dpanel_users (username, password_hash, role) VALUES (?, ?, ?)',
    [username, hash, role]
  );
  const userId = res.insertId;
  if (domains.length) {
    const vals = domains.map(d => [userId, d]);
    await pool.query('INSERT INTO dpanel_user_domains (user_id, domain) VALUES ?', [vals]);
  }
  return userId;
}

async function updateUser(id, { password, role, domains }) {
  if (password) {
    const hash = await bcrypt.hash(password, 12);
    await pool.query('UPDATE dpanel_users SET password_hash = ? WHERE id = ?', [hash, id]);
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

module.exports = { listUsers, getUser, createUser, updateUser, deleteUser };
