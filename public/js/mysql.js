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
        <td style="text-align:right;display:flex;gap:6px;justify-content:flex-end">
          <button class="btn btn-ghost btn-xs"  onclick="window.mysqlMgr.openBrowser('${db.name}')">Browse</button>
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

  // ── Database Browser (phpMyAdmin-style) ───────────────────────────────────────

  let _browserDb     = null;
  let _browserTable  = null;
  let _browserTab    = 'browse';
  let _browsePage    = 0;
  const _browsePageSize = 50;

  function _escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  function _renderCell(val) {
    if (val === null || val === undefined) return '<span style="color:var(--text-muted);font-style:italic">NULL</span>';
    if (typeof val === 'boolean') return val ? 'true' : 'false';
    if (typeof val === 'number')  return _escapeHtml(String(val));
    let s = typeof val === 'string' ? val : JSON.stringify(val);
    // Truncate huge cells inline; full value still in title attribute for hover
    const truncated = s.length > 200;
    const display = truncated ? s.slice(0, 200) + '…' : s;
    return `<span title="${_escapeHtml(s)}">${_escapeHtml(display)}</span>`;
  }

  async function openBrowser(db) {
    _browserDb    = db;
    _browserTable = null;
    _browserTab   = 'browse';
    _browsePage   = 0;
    document.getElementById('mysqlBrowserCrumb').textContent = db;
    document.getElementById('mysqlBrowserTables').innerHTML = '<li style="padding:var(--space-3) var(--space-4);color:var(--text-muted);font-size:0.8125rem">Loading…</li>';
    document.getElementById('mysqlBrowseRows').innerHTML = '<div class="empty-state"><p>Select a table from the left.</p></div>';
    document.getElementById('mysqlBrowseControls').innerHTML = '';
    document.getElementById('mysqlStructureContent').innerHTML = '';
    document.getElementById('mysqlSqlInput').value = `SELECT * FROM <table> LIMIT 25`;
    document.getElementById('mysqlSqlResult').innerHTML = '';
    document.getElementById('mysqlSqlStatus').textContent = '';
    document.getElementById('modalMysqlBrowser').classList.add('open');

    const data = await api.get(`/api/mysql/databases/${encodeURIComponent(db)}/tables`);
    const ul = document.getElementById('mysqlBrowserTables');
    if (!data?.success) {
      ul.innerHTML = `<li style="padding:var(--space-3) var(--space-4);color:var(--text-error);font-size:0.8125rem">${_escapeHtml(data?.error || 'Failed to load tables')}</li>`;
      return;
    }
    if (!data.data.length) {
      ul.innerHTML = '<li style="padding:var(--space-3) var(--space-4);color:var(--text-muted);font-size:0.8125rem">No tables in this database.</li>';
      return;
    }
    ul.innerHTML = data.data.map(t => `
      <li>
        <button onclick="window.mysqlMgr.selectTable('${_escapeHtml(t.name)}')"
                data-table="${_escapeHtml(t.name)}"
                style="width:100%;text-align:left;padding:var(--space-2) var(--space-4);background:none;border:none;border-left:3px solid transparent;color:var(--text-primary);cursor:pointer;font-size:0.8125rem;font-family:var(--font-mono);display:flex;justify-content:space-between;align-items:center">
          <span>${_escapeHtml(t.name)}</span>
          <span style="font-size:0.6875rem;color:var(--text-muted);font-family:var(--font-sans, sans-serif)">${t.row_estimate || 0}</span>
        </button>
      </li>`).join('');
  }

  function closeBrowser() {
    document.getElementById('modalMysqlBrowser').classList.remove('open');
    _browserDb    = null;
    _browserTable = null;
  }

  function selectTable(table) {
    _browserTable = table;
    _browsePage   = 0;
    // Highlight active row in sidebar
    document.querySelectorAll('#mysqlBrowserTables button').forEach(btn => {
      btn.style.borderLeftColor = btn.dataset.table === table ? 'var(--accent)' : 'transparent';
      btn.style.background = btn.dataset.table === table ? 'rgba(79,142,247,0.08)' : 'none';
    });
    document.getElementById('mysqlBrowserCrumb').textContent = `${_browserDb}  →  ${table}`;
    document.getElementById('mysqlSqlInput').value = `SELECT * FROM ${table} LIMIT 25`;
    if (_browserTab === 'browse')    loadBrowseRows();
    else if (_browserTab === 'structure') loadStructure();
  }

  function switchBrowserTab(tab) {
    _browserTab = tab;
    ['browse','structure','sql'].forEach(t => {
      const tabEl = document.getElementById('mysqlBrowserTab' + t.charAt(0).toUpperCase() + t.slice(1));
      if (tabEl) tabEl.classList.toggle('active', t === tab);
      const paneId = `mysql${t.charAt(0).toUpperCase() + t.slice(1)}Pane`;
      const pane = document.getElementById(paneId);
      if (pane) {
        pane.classList.toggle('active', t === tab);
        pane.style.display = (t === tab) ? '' : 'none';
      }
    });
    if (_browserTable) {
      if (tab === 'browse')    loadBrowseRows();
      else if (tab === 'structure') loadStructure();
    }
  }

  async function loadBrowseRows() {
    if (!_browserTable) return;
    const target = document.getElementById('mysqlBrowseRows');
    const ctrls  = document.getElementById('mysqlBrowseControls');
    target.innerHTML = '<div class="empty-state"><p>Loading…</p></div>';
    const offset = _browsePage * _browsePageSize;
    const data = await api.get(`/api/mysql/databases/${encodeURIComponent(_browserDb)}/tables/${encodeURIComponent(_browserTable)}/rows?limit=${_browsePageSize}&offset=${offset}`);
    if (!data?.success) {
      target.innerHTML = `<div class="empty-state"><p style="color:var(--text-error)">${_escapeHtml(data?.error || 'Error')}</p></div>`;
      ctrls.innerHTML = '';
      return;
    }
    const { rows, columns, total, limit } = data.data;
    const start = offset + 1;
    const end   = Math.min(offset + rows.length, total);
    const pages = Math.max(1, Math.ceil(total / limit));
    ctrls.innerHTML = `
      <div>${total.toLocaleString()} rows · showing ${start}–${end}</div>
      <div style="flex:1"></div>
      <button class="btn btn-ghost btn-xs" onclick="window.mysqlMgr.browsePagePrev()" ${_browsePage === 0 ? 'disabled' : ''}>‹ Prev</button>
      <span style="font-size:0.75rem">Page ${_browsePage + 1} / ${pages}</span>
      <button class="btn btn-ghost btn-xs" onclick="window.mysqlMgr.browsePageNext()" ${_browsePage + 1 >= pages ? 'disabled' : ''}>Next ›</button>`;

    if (!rows.length) {
      target.innerHTML = '<div class="empty-state"><p>No rows.</p></div>';
      return;
    }
    target.innerHTML = `
      <table style="width:100%;font-size:0.8125rem">
        <thead><tr>${columns.map(c => `<th style="white-space:nowrap;font-family:var(--font-mono);font-size:0.75rem">${_escapeHtml(c)}</th>`).join('')}</tr></thead>
        <tbody>${rows.map(r => `
          <tr>${columns.map(c => `<td style="font-family:var(--font-mono);font-size:0.75rem;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_renderCell(r[c])}</td>`).join('')}</tr>`).join('')}
        </tbody>
      </table>`;
  }

  function browsePagePrev() { if (_browsePage > 0) { _browsePage--; loadBrowseRows(); } }
  function browsePageNext() { _browsePage++; loadBrowseRows(); }

  async function loadStructure() {
    if (!_browserTable) return;
    const target = document.getElementById('mysqlStructureContent');
    target.innerHTML = '<div class="empty-state"><p>Loading…</p></div>';
    const data = await api.get(`/api/mysql/databases/${encodeURIComponent(_browserDb)}/tables/${encodeURIComponent(_browserTable)}/structure`);
    if (!data?.success) {
      target.innerHTML = `<div class="empty-state"><p style="color:var(--text-error)">${_escapeHtml(data?.error || 'Error')}</p></div>`;
      return;
    }
    const { meta, columns, indexes } = data.data;
    target.innerHTML = `
      <div style="display:flex;gap:var(--space-4);margin-bottom:var(--space-4);font-size:0.8125rem;color:var(--text-muted);flex-wrap:wrap">
        <div>Engine: <code style="color:var(--text-secondary)">${_escapeHtml(meta.engine || '—')}</code></div>
        <div>Rows (est): <code style="color:var(--text-secondary)">${meta.row_estimate || 0}</code></div>
        <div>Created: <code style="color:var(--text-secondary)">${_escapeHtml(meta.created_at || '—')}</code></div>
      </div>
      <h4 style="margin-bottom:var(--space-2);font-size:0.875rem">Columns</h4>
      <table style="width:100%;font-size:0.8125rem;margin-bottom:var(--space-5)">
        <thead><tr><th>Field</th><th>Type</th><th>Null</th><th>Key</th><th>Default</th><th>Extra</th></tr></thead>
        <tbody>${columns.map(c => `
          <tr>
            <td style="font-family:var(--font-mono)">${_escapeHtml(c.Field)}</td>
            <td style="font-family:var(--font-mono);color:var(--text-muted)">${_escapeHtml(c.Type)}</td>
            <td>${c.Null}</td>
            <td>${c.Key ? `<span class="badge badge-muted">${_escapeHtml(c.Key)}</span>` : ''}</td>
            <td style="font-family:var(--font-mono);color:var(--text-muted)">${_escapeHtml(c.Default ?? '')}</td>
            <td style="font-size:0.75rem;color:var(--text-muted)">${_escapeHtml(c.Extra || '')}</td>
          </tr>`).join('')}
        </tbody>
      </table>
      <h4 style="margin-bottom:var(--space-2);font-size:0.875rem">Indexes</h4>
      ${indexes.length === 0 ? '<p style="color:var(--text-muted);font-size:0.8125rem">No indexes.</p>' : `
      <table style="width:100%;font-size:0.8125rem">
        <thead><tr><th>Name</th><th>Column</th><th>Unique</th><th>Type</th></tr></thead>
        <tbody>${indexes.map(i => `
          <tr>
            <td style="font-family:var(--font-mono)">${_escapeHtml(i.Key_name)}</td>
            <td style="font-family:var(--font-mono)">${_escapeHtml(i.Column_name)}</td>
            <td>${i.Non_unique == 0 ? 'yes' : 'no'}</td>
            <td style="color:var(--text-muted)">${_escapeHtml(i.Index_type)}</td>
          </tr>`).join('')}
        </tbody>
      </table>`}
    `;
  }

  async function runSql() {
    const query = document.getElementById('mysqlSqlInput').value;
    const result = document.getElementById('mysqlSqlResult');
    const status = document.getElementById('mysqlSqlStatus');
    if (!query.trim()) { toast('error', 'SQL', 'Query is empty.'); return; }
    status.textContent = 'Running…';
    result.innerHTML = '';
    const data = await api.post(`/api/mysql/databases/${encodeURIComponent(_browserDb)}/query`, { query });
    if (!data?.success) {
      status.textContent = '';
      result.innerHTML = `<div style="padding:var(--space-3);background:rgba(224,92,106,0.08);border:1px solid rgba(224,92,106,0.3);border-radius:var(--radius-sm);color:var(--text-error);font-family:var(--font-mono);font-size:0.8125rem;white-space:pre-wrap">${_escapeHtml(data?.error || 'Query failed')}</div>`;
      return;
    }
    const r = data.data;
    if (r.kind === 'rows') {
      status.textContent = `${r.rowCount} row${r.rowCount === 1 ? '' : 's'} · ${r.executionMs}ms${r.truncated ? ` · capped at ${r.rows.length}` : ''}`;
      if (!r.rows.length) { result.innerHTML = '<p style="color:var(--text-muted);font-size:0.8125rem">No rows.</p>'; return; }
      result.innerHTML = `
        <table style="width:100%;font-size:0.8125rem">
          <thead><tr>${r.columns.map(c => `<th style="font-family:var(--font-mono);font-size:0.75rem">${_escapeHtml(c)}</th>`).join('')}</tr></thead>
          <tbody>${r.rows.map(row => `
            <tr>${r.columns.map(c => `<td style="font-family:var(--font-mono);font-size:0.75rem;max-width:400px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_renderCell(row[c])}</td>`).join('')}</tr>`).join('')}
          </tbody>
        </table>`;
    } else {
      status.textContent = `${r.affectedRows} affected · ${r.executionMs}ms`;
      const info = [r.info, r.insertId ? `insertId=${r.insertId}` : null].filter(Boolean).join(' · ');
      result.innerHTML = `<div style="padding:var(--space-3);background:rgba(74,222,128,0.08);border:1px solid rgba(74,222,128,0.3);border-radius:var(--radius-sm);color:var(--text-success,#4ade80);font-family:var(--font-mono);font-size:0.8125rem">OK${info ? ' · ' + _escapeHtml(info) : ''}</div>`;
    }
  }

  return {
    load, createDatabase, confirmDropDb, submitDropDb, createUser, confirmDropUser, openChangePw, submitChangePw, installMySQL, copyCred,
    openBrowser, closeBrowser, selectTable, switchBrowserTab, browsePagePrev, browsePageNext, runSql,
  };
})();
