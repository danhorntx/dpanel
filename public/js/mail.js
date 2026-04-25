// ── Mail module ───────────────────────────────────────────────────────────────
window.mail = (() => {
  let currentTab = 'accounts';

  function switchTab(tab, el) {
    currentTab = tab;
    document.querySelectorAll('.tabs .tab').forEach(t => t.classList.toggle('active', t === el));
    document.getElementById('tab-accounts').classList.toggle('active', tab === 'accounts');
    document.getElementById('tab-forwards').classList.toggle('active', tab === 'forwards');
    const addBtn = document.getElementById('mailAddBtn');
    addBtn.onclick = tab === 'accounts' ? () => openModal('modalAddAccount') : () => openModal('modalAddForward');
    if (tab === 'accounts') loadAccounts(); else loadForwards();
  }

  async function loadAll() {
    await loadAccounts();
    await loadForwards();
    // Wire up add button
    const addBtn = document.getElementById('mailAddBtn');
    addBtn.onclick = () => openModal(currentTab === 'accounts' ? 'modalAddAccount' : 'modalAddForward');
  }

  async function loadAccounts() {
    const tbody = document.getElementById('accountsTable');
    tbody.innerHTML = `<tr><td colspan="3"><div class="empty-state"><p>Loading...</p></div></td></tr>`;
    const data = await api.get('/api/mail/accounts');
    if (!data?.success) {
      tbody.innerHTML = `<tr><td colspan="3"><div class="empty-state"><p class="text-red">${data?.error || 'Failed'}</p></div></td></tr>`;
      return;
    }
    if (!data.data.length) {
      tbody.innerHTML = `<tr><td colspan="3"><div class="empty-state">
        <h4>No mailboxes</h4><p>Create a mail account to get started.</p>
      </div></td></tr>`;
      return;
    }
    tbody.innerHTML = data.data.map(a => `
      <tr>
        <td><span class="font-medium">${a.email}</span></td>
        <td class="td-mono">${a.quota || '—'}</td>
        <td>
          <div class="td-actions" style="justify-content:flex-end">
            <button class="btn btn-ghost btn-xs" onclick="mail.openChangePassword('${a.email}')">Change Password</button>
            <button class="btn btn-danger btn-xs" onclick="mail.confirmDeleteAccount(this, '${a.email}')">Delete</button>
          </div>
        </td>
      </tr>`).join('');
  }

  async function loadForwards() {
    const tbody = document.getElementById('forwardsTable');
    tbody.innerHTML = `<tr><td colspan="3"><div class="empty-state"><p>Loading...</p></div></td></tr>`;
    const data = await api.get('/api/mail/forwards');
    if (!data?.success) {
      tbody.innerHTML = `<tr><td colspan="3"><div class="empty-state"><p class="text-red">${data?.error || 'Failed'}</p></div></td></tr>`;
      return;
    }
    if (!data.data.length) {
      tbody.innerHTML = `<tr><td colspan="3"><div class="empty-state">
        <h4>No forwards</h4><p>Add forwarding rules to route mail.</p>
      </div></td></tr>`;
      return;
    }
    tbody.innerHTML = data.data.map(f => `
      <tr>
        <td class="td-mono">${f.source}</td>
        <td class="td-mono text-secondary">${f.destinations}</td>
        <td>
          <div class="td-actions" style="justify-content:flex-end">
            <button class="btn btn-danger btn-xs" onclick="mail.deleteForward('${f.source}')">Delete</button>
          </div>
        </td>
      </tr>`).join('');
  }

  async function addAccount() {
    const email = document.getElementById('addAccountEmail').value.trim();
    const password = document.getElementById('addAccountPassword').value;
    const quota = document.getElementById('addAccountQuota').value.trim() || '1G';
    if (!email || !password) return toast('error', 'Validation', 'Email and password are required.');
    const btn = document.querySelector('#modalAddAccount .btn-primary');
    btn.classList.add('loading'); btn.disabled = true;
    const data = await api.post('/api/mail/accounts', { email, password, quota });
    btn.classList.remove('loading'); btn.disabled = false;
    if (data?.success) {
      toast('success', 'Account created', email);
      closeModal('modalAddAccount');
      document.getElementById('addAccountEmail').value = '';
      document.getElementById('addAccountPassword').value = '';
      document.getElementById('addAccountQuota').value = '';
      loadAccounts();
    } else toast('error', 'Error', data?.error);
  }

  async function addForward() {
    const source = document.getElementById('addForwardSource').value.trim();
    const dests  = document.getElementById('addForwardDests').value.trim();
    if (!source || !dests) return toast('error', 'Validation', 'Source and destination required.');
    const btn = document.querySelector('#modalAddForward .btn-primary');
    btn.classList.add('loading'); btn.disabled = true;
    const data = await api.post('/api/mail/forwards', { source, destinations: dests });
    btn.classList.remove('loading'); btn.disabled = false;
    if (data?.success) {
      toast('success', 'Forward added', `${source} → ${dests}`);
      closeModal('modalAddForward');
      document.getElementById('addForwardSource').value = '';
      document.getElementById('addForwardDests').value = '';
      loadForwards();
    } else toast('error', 'Error', data?.error);
  }

  function openChangePassword(email) {
    document.getElementById('changePasswordEmail').value = email;
    document.getElementById('changePasswordValue').value = '';
    openModal('modalChangePassword');
  }

  async function changePassword() {
    const email = document.getElementById('changePasswordEmail').value;
    const password = document.getElementById('changePasswordValue').value;
    if (!password) return toast('error', 'Validation', 'Password is required.');
    const btn = document.querySelector('#modalChangePassword .btn-primary');
    btn.classList.add('loading'); btn.disabled = true;
    const data = await api.put(`/api/mail/accounts/${encodeURIComponent(email)}`, { password });
    btn.classList.remove('loading'); btn.disabled = false;
    if (data?.success) { toast('success', 'Password updated', email); closeModal('modalChangePassword'); }
    else toast('error', 'Error', data?.error);
  }

  function confirmDeleteAccount(btn, email) {
    const existing = btn.parentNode.querySelector('.confirm-prompt');
    if (existing) { deleteAccount(email); return; }
    const prompt = document.createElement('span');
    prompt.className = 'confirm-prompt'; prompt.textContent = 'Click again to confirm';
    btn.parentNode.insertBefore(prompt, btn);
    setTimeout(() => { if (prompt.parentNode) prompt.remove(); }, 3000);
  }

  async function deleteAccount(email) {
    const data = await api.del(`/api/mail/accounts/${encodeURIComponent(email)}`);
    if (data?.success) { toast('success', 'Deleted', email); loadAccounts(); }
    else toast('error', 'Error', data?.error);
  }

  async function deleteForward(source) {
    const data = await api.del(`/api/mail/forwards/${encodeURIComponent(source)}`);
    if (data?.success) { toast('success', 'Forward removed', source); loadForwards(); }
    else toast('error', 'Error', data?.error);
  }

  function openModal(id) { document.getElementById(id).classList.add('open'); }
  function closeModal(id) { document.getElementById(id).classList.remove('open'); }

  return { switchTab, loadAll, loadAccounts, loadForwards, addAccount, addForward,
           openChangePassword, changePassword, confirmDeleteAccount, deleteAccount, deleteForward,
           openModal, closeModal };
})();
