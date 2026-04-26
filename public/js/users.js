// ── Users module ──────────────────────────────────────────────────────────────
window.usersMgr = (() => {
  let _allDomains = [];

  async function load() {
    const tbody = document.getElementById('usersTable');
    if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="4"><div class="empty-state"><p>Loading...</p></div></td></tr>`;
    // Load domain list for the picker
    const domData = await api.get('/api/domains');
    _allDomains = domData?.success ? domData.data.map(d => d.domain) : [];

    const data = await api.get('/api/users');
    if (!data?.success) {
      tbody.innerHTML = `<tr><td colspan="4"><div class="empty-state"><p class="text-red">${data?.error || 'Failed'}</p></div></td></tr>`;
      return;
    }
    if (!data.data.length) {
      tbody.innerHTML = `<tr><td colspan="4"><div class="empty-state"><h4>No users</h4><p>Add users to share panel access.</p></div></td></tr>`;
      return;
    }
    tbody.innerHTML = data.data.map(u => `
      <tr>
        <td><span class="font-medium">${u.username}</span></td>
        <td><span class="badge badge-${u.role === 'admin' ? 'green' : 'blue'}">${u.role}</span></td>
        <td class="text-secondary text-sm">${u.role === 'admin' ? 'All domains' : (u.domains.join(', ') || '—')}</td>
        <td>
          <div class="td-actions" style="justify-content:flex-end">
            <button class="btn btn-ghost btn-xs" onclick="usersMgr.openEdit(${u.id})">Edit</button>
            <button class="btn btn-danger btn-xs" onclick="usersMgr.confirmDelete(this, ${u.id}, '${u.username}')">Delete</button>
          </div>
        </td>
      </tr>`).join('');
  }

  function openAdd() {
    document.getElementById('userFormId').value = '';
    document.getElementById('userFormTitle').textContent = 'Add User';
    document.getElementById('userFormUsername').value = '';
    document.getElementById('userFormUsername').disabled = false;
    document.getElementById('userFormPassword').value = '';
    document.getElementById('userFormPassword').placeholder = 'Password';
    document.getElementById('userFormRole').value = 'user';
    _renderDomainPicker([]);
    _toggleDomainPicker('user');
    document.getElementById('modalUserForm').classList.add('open');
  }

  async function openEdit(id) {
    const data = await api.get(`/api/users/${id}`);
    if (!data?.success) return toast('error', 'Error', data?.error);
    const u = data.data;
    document.getElementById('userFormId').value = u.id;
    document.getElementById('userFormTitle').textContent = 'Edit User';
    document.getElementById('userFormUsername').value = u.username;
    document.getElementById('userFormUsername').disabled = true;
    document.getElementById('userFormPassword').value = '';
    document.getElementById('userFormPassword').placeholder = 'Leave blank to keep current';
    document.getElementById('userFormRole').value = u.role;
    _renderDomainPicker(u.domains);
    _toggleDomainPicker(u.role);
    document.getElementById('modalUserForm').classList.add('open');
  }

  function _renderDomainPicker(selected) {
    const wrap = document.getElementById('userDomainPicker');
    if (!_allDomains.length) {
      wrap.innerHTML = '<p class="text-secondary text-sm">No domains available</p>';
      return;
    }
    wrap.innerHTML = _allDomains.map(d => `
      <label class="checkbox-row">
        <input type="checkbox" value="${d}" ${selected.includes(d) ? 'checked' : ''}>
        <span>${d}</span>
      </label>`).join('');
  }

  function _toggleDomainPicker(role) {
    const wrap = document.getElementById('userDomainSection');
    if (wrap) wrap.style.display = role === 'admin' ? 'none' : 'block';
  }

  async function save() {
    const id       = document.getElementById('userFormId').value;
    const username = document.getElementById('userFormUsername').value.trim();
    const password = document.getElementById('userFormPassword').value;
    const role     = document.getElementById('userFormRole').value;
    const domains  = [...document.querySelectorAll('#userDomainPicker input[type=checkbox]:checked')]
                       .map(cb => cb.value);

    const btn = document.querySelector('#modalUserForm .btn-primary');
    btn.classList.add('loading'); btn.disabled = true;

    let data;
    if (id) {
      data = await api.put(`/api/users/${id}`, { password: password || undefined, role, domains });
    } else {
      if (!username || !password) {
        btn.classList.remove('loading'); btn.disabled = false;
        return toast('error', 'Validation', 'Username and password are required');
      }
      data = await api.post('/api/users', { username, password, role, domains });
    }

    btn.classList.remove('loading'); btn.disabled = false;
    if (data?.success) {
      toast('success', id ? 'User updated' : 'User created', username);
      document.getElementById('modalUserForm').classList.remove('open');
      load();
    } else {
      toast('error', 'Error', data?.error);
    }
  }

  function confirmDelete(btn, id, username) {
    const existing = btn.parentNode.querySelector('.confirm-prompt');
    if (existing) { doDelete(id, username); return; }
    const prompt = document.createElement('span');
    prompt.className = 'confirm-prompt'; prompt.textContent = 'Click again to confirm';
    btn.parentNode.insertBefore(prompt, btn);
    setTimeout(() => { if (prompt.parentNode) prompt.remove(); }, 3000);
  }

  async function doDelete(id, username) {
    const data = await api.del(`/api/users/${id}`);
    if (data?.success) { toast('success', 'Deleted', username); load(); }
    else toast('error', 'Error', data?.error);
  }

  return { load, openAdd, openEdit, save, confirmDelete };
})();
