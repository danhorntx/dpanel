'use strict';
window.mysqlMgr = (() => {
  let _dbs = [], _users = [];

  async function load() {
    setLoading('mysqlDbTable', 3);
    setLoading('mysqlUserTable', 3);
    const data = await api.get('/api/mysql');
    if (!data?.success) return toast('error', 'MySQL', data?.error || 'Failed to load');

    if (!data.data.installed) {
      document.getElementById('mysqlNotInstalled').style.display = '';
      document.getElementById('mysqlContent').style.display = 'none';
      return;
    }
    document.getElementById('mysqlNotInstalled').style.display = 'none';
    document.getElementById('mysqlContent').style.display = '';

    _dbs   = data.data.databases || [];
    _users = data.data.users     || [];
    renderDatabases(_dbs);
    renderUsers(_users);
    populateDbSelect();
  }

  function setLoading(id, cols) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = `<tr><td colspan="${cols}"><div class="empty-state"><p>Loading…</p></div></td></tr>`;
  }

  function renderDatabases(dbs) {
    const tbody = document.getElementById('mysqlDbTable');
    if (!dbs.length) {
      tbody.innerHTML = `<tr><td colspan="3"><div class="empty-state"><h4>No databases</h4><p>Create your first database below.</p></div></td></tr>`;
      return;
    }
    tbody.innerHTML = dbs.map(db => `
      <tr>
        <td><span class="font-medium" style="font-family:var(--font-mono)">${db.name}</span></td>
        <td><span style="font-size:0.8125rem;color:var(--text-muted)">${db.sizeMb} MB</span></td>
        <td style="text-align:right">
          <button class="btn btn-danger btn-xs" onclick="window.mysqlMgr.confirmDropDb('${db.name}')">Drop</button>
        </td>
      </tr>`).join('');
  }

  function renderUsers(users) {
    const tbody = document.getElementById('mysqlUserTable');
    if (!users.length) {
      tbody.innerHTML = `<tr><td colspan="3"><div class="empty-state"><p>No users configured.</p></div></td></tr>`;
      return;
    }
    tbody.innerHTML = users.map(u => `
      <tr>
        <td><span class="font-medium" style="font-family:var(--font-mono)">${u.user}</span></td>
        <td><span style="font-size:0.8125rem;color:var(--text-muted)">${u.host}</span></td>
        <td style="text-align:right;display:flex;gap:6px;justify-content:flex-end">
          <button class="btn btn-ghost btn-xs" onclick="window.mysqlMgr.openChangePw('${u.user}')">Change PW</button>
          <button class="btn btn-danger btn-xs" onclick="window.mysqlMgr.confirmDropUser('${u.user}')">Drop</button>
        </td>
      </tr>`).join('');
  }

  function populateDbSelect() {
    const sel = document.getElementById('mysqlUserDb');
    if (!sel) return;
    sel.innerHTML = _dbs.map(db => `<option value="${db.name}">${db.name}</option>`).join('');
  }

  // ── Create Database ──────────────────────────────────────────────────────────
  async function createDatabase() {
    const name = document.getElementById('mysqlNewDbName').value.trim();
    if (!name) return toast('error', 'Validation', 'Database name required.');
    const btn = document.getElementById('mysqlCreateDbBtn');
    btn.disabled = true; btn.textContent = 'Creating…';
    const data = await api.post('/api/mysql/databases', { name });
    btn.disabled = false; btn.textContent = 'Create';
    if (data?.success) { toast('success', 'Created', `Database ${name} ready.`); document.getElementById('mysqlNewDbName').value = ''; load(); }
    else toast('error', 'Failed', data?.error);
  }

  let _pendingDropDb = null;
  function confirmDropDb(name) {
    _pendingDropDb = name;
    document.getElementById('mysqlDropDbName').textContent = name;
    document.getElementById('modalDropDb').classList.add('open');
  }
  async function submitDropDb() {
    if (!_pendingDropDb) return;
    const name = _pendingDropDb;
    document.getElementById('modalDropDb').classList.remove('open');
    _pendingDropDb = null;
    const data = await api.del(`/api/mysql/databases/${name}`);
    if (data?.success) { toast('success', 'Dropped', `${name} deleted.`); load(); }
    else toast('error', 'Failed', data?.error);
  }

  // ── Create User ──────────────────────────────────────────────────────────────
  async function createUser() {
    const user     = document.getElementById('mysqlNewUser').value.trim();
    const password = document.getElementById('mysqlNewUserPw').value;
    const database = document.getElementById('mysqlUserDb').value;
    if (!user) return toast('error', 'Validation', 'Username required.');
    if (!database) return toast('error', 'Validation', 'Select a database.');
    const btn = document.getElementById('mysqlCreateUserBtn');
    btn.disabled = true; btn.textContent = 'Creating…';
    const data = await api.post('/api/mysql/users', { user, password: password || undefined, database });
    btn.disabled = false; btn.textContent = 'Create User';
    if (data?.success) {
      const d = data.data;
      toast('success', 'User created', `${d.user} → ${d.database}`);
      if (!password) {
        document.getElementById('mysqlCredsUser').textContent = d.user;
        document.getElementById('mysqlCredsDb').textContent   = d.database;
        document.getElementById('mysqlCredsPw').textContent   = d.password;
        document.getElementById('modalMysqlCreds').classList.add('open');
      }
      document.getElementById('mysqlNewUser').value   = '';
      document.getElementById('mysqlNewUserPw').value = '';
      load();
    } else toast('error', 'Failed', data?.error);
  }

  // ── Drop User ────────────────────────────────────────────────────────────────
  let _pendingDropUser = null;
  function confirmDropUser(user) {
    _pendingDropUser = user;
    if (confirm(`Drop user "${user}"?`)) dropUser(user);
  }
  async function dropUser(user) {
    const data = await api.del(`/api/mysql/users/${user}`);
    if (data?.success) { toast('success', 'Dropped', user); load(); }
    else toast('error', 'Failed', data?.error);
  }

  // ── Change Password ──────────────────────────────────────────────────────────
  let _editingUser = null;
  function openChangePw(user) {
    _editingUser = user;
    document.getElementById('mysqlChangePwUser').textContent = user;
    document.getElementById('mysqlNewPw').value = '';
    document.getElementById('modalChangeMysqlPw').classList.add('open');
  }
  async function submitChangePw() {
    const pw = document.getElementById('mysqlNewPw').value;
    if (!pw || pw.length < 8) return toast('error', 'Validation', 'Password must be at least 8 characters.');
    const data = await api.put(`/api/mysql/users/${_editingUser}/password`, { password: pw });
    document.getElementById('modalChangeMysqlPw').classList.remove('open');
    if (data?.success) toast('success', 'Password changed', _editingUser);
    else toast('error', 'Failed', data?.error);
  }

  async function installMySQL() {
    const btn = document.getElementById('mysqlInstallBtn');
    btn.disabled = true; btn.textContent = 'Installing…';
    toast('warning', 'Installing MariaDB…', 'This may take a minute.');
    const data = await api.post('/api/mysql/install', {});
    btn.disabled = false; btn.textContent = 'Install MariaDB';
    if (data?.success) { toast('success', 'MariaDB installed', 'Ready to use.'); load(); }
    else toast('error', 'Install failed', data?.error);
  }

  function copyCred(id) {
    const el = document.getElementById(id);
    if (!el) return;
    navigator.clipboard.writeText(el.textContent).then(() => toast('success', 'Copied', ''));
  }

  return { load, createDatabase, confirmDropDb, submitDropDb, createUser, confirmDropUser, openChangePw, submitChangePw, installMySQL, copyCred };
})();
