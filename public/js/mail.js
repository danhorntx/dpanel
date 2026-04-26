// ── Mail module ───────────────────────────────────────────────────────────────
window.mail = (() => {
  let currentTab = 'accounts';

  function switchTab(tab, el) {
    currentTab = tab;
    document.querySelectorAll('#mailSection .tabs .tab').forEach(t => t.classList.toggle('active', t === el));
    ['accounts','forwards','dkim'].forEach(id => {
      const el = document.getElementById(`tab-mail-${id}`);
      if (el) el.classList.toggle('active', id === tab);
    });
    const addBtn = document.getElementById('mailAddBtn');
    if (addBtn) {
      if (tab === 'accounts') { addBtn.style.display = ''; addBtn.onclick = () => openModal('modalAddAccount'); }
      else if (tab === 'forwards') { addBtn.style.display = ''; addBtn.onclick = () => openModal('modalAddForward'); }
      else { addBtn.style.display = 'none'; }
    }
    if (tab === 'accounts') loadAccounts();
    else if (tab === 'forwards') loadForwards();
    else loadDkim();
  }

  async function loadAll() {
    await loadAccounts();
    const addBtn = document.getElementById('mailAddBtn');
    if (addBtn) addBtn.onclick = () => openModal('modalAddAccount');
  }

  // ── Accounts ─────────────────────────────────────────────────────────────────
  async function loadAccounts() {
    const tbody = document.getElementById('accountsTable');
    if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="3"><div class="empty-state"><p>Loading...</p></div></td></tr>`;
    const data = await api.get('/api/mail/accounts');
    if (!data?.success) {
      tbody.innerHTML = `<tr><td colspan="3"><div class="empty-state"><p class="text-red">${data?.error || 'Failed'}</p></div></td></tr>`;
      return;
    }
    if (!data.data.length) {
      tbody.innerHTML = `<tr><td colspan="3"><div class="empty-state"><h4>No mailboxes</h4><p>Create a mail account to get started.</p></div></td></tr>`;
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

  // ── Forwards ──────────────────────────────────────────────────────────────────
  async function loadForwards() {
    const tbody = document.getElementById('forwardsTable');
    if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="3"><div class="empty-state"><p>Loading...</p></div></td></tr>`;
    const data = await api.get('/api/mail/forwards');
    if (!data?.success) {
      tbody.innerHTML = `<tr><td colspan="3"><div class="empty-state"><p class="text-red">${data?.error || 'Failed'}</p></div></td></tr>`;
      return;
    }
    if (!data.data.length) {
      tbody.innerHTML = `<tr><td colspan="3"><div class="empty-state"><h4>No forwards</h4><p>Add forwarding rules to route mail.</p></div></td></tr>`;
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

  // ── DKIM ──────────────────────────────────────────────────────────────────────
  async function loadDkim() {
    const wrap = document.getElementById('tab-mail-dkim');
    if (!wrap) return;
    // Load available domains
    const domData = await api.get('/api/domains');
    const domains = domData?.success ? domData.data.map(d => d.domain) : [];
    if (!domains.length) {
      wrap.innerHTML = `<div class="empty-state"><h4>No domains</h4><p>Add a domain first.</p></div>`;
      return;
    }

    wrap.innerHTML = `<div class="table-wrap"><table class="table"><thead><tr>
      <th>Domain</th><th>DKIM</th><th>SPF</th><th>DMARC</th><th style="text-align:right">Actions</th>
    </tr></thead><tbody id="dkimTableBody">
      <tr><td colspan="5"><div class="empty-state"><p>Loading...</p></div></td></tr>
    </tbody></table></div>`;

    const rows = await Promise.all(domains.map(async domain => {
      const [dkimRes, dnsRes] = await Promise.all([
        api.get(`/api/mail/dkim/${domain}`),
        api.get(`/api/mail/dns/${domain}`)
      ]);
      return { domain, dkim: dkimRes?.data, dns: dnsRes?.data };
    }));

    document.getElementById('dkimTableBody').innerHTML = rows.map(r => {
      const dkimOk  = r.dkim?.enabled;
      const spfOk   = r.dns?.verified?.spf?.ok;
      const dmarcOk = r.dns?.verified?.dmarc?.ok;
      const dkimDns = r.dns?.verified?.dkim?.ok;
      return `<tr>
        <td><span class="font-medium">${r.domain}</span></td>
        <td><span class="badge badge-${dkimOk && dkimDns ? 'green' : dkimOk ? 'yellow' : 'red'}">${dkimOk ? (dkimDns ? 'Active' : 'Key ready — DNS needed') : 'Not configured'}</span></td>
        <td><span class="badge badge-${spfOk ? 'green' : 'red'}">${spfOk ? 'OK' : 'Missing'}</span></td>
        <td><span class="badge badge-${dmarcOk ? 'green' : 'red'}">${dmarcOk ? 'OK' : 'Missing'}</span></td>
        <td>
          <div class="td-actions" style="justify-content:flex-end">
            <button class="btn btn-ghost btn-xs" onclick="mail.showDnsRecords('${r.domain}')">DNS Records</button>
            ${dkimOk
              ? `<button class="btn btn-danger btn-xs" onclick="mail.removeDkim('${r.domain}')">Remove DKIM</button>`
              : `<button class="btn btn-primary btn-xs" onclick="mail.generateDkim('${r.domain}')">Generate DKIM</button>`
            }
          </div>
        </td>
      </tr>`;
    }).join('');
  }

  async function generateDkim(domain) {
    toast('info', 'DKIM', `Generating key for ${domain}…`);
    const data = await api.post(`/api/mail/dkim/${domain}`, {});
    if (data?.success) {
      toast('success', 'DKIM key generated', domain);
      showDnsRecords(domain);
      loadDkim();
    } else {
      toast('error', 'Error', data?.error);
    }
  }

  async function removeDkim(domain) {
    const data = await api.del(`/api/mail/dkim/${domain}`);
    if (data?.success) { toast('success', 'DKIM removed', domain); loadDkim(); }
    else toast('error', 'Error', data?.error);
  }

  async function showDnsRecords(domain) {
    const data = await api.get(`/api/mail/dns/${domain}`);
    if (!data?.success) return toast('error', 'Error', data?.error);
    const { records, verified } = data.data;
    const modal = document.getElementById('modalDnsRecords');
    document.getElementById('dnsRecordsDomain').textContent = domain;
    document.getElementById('dnsRecordsList').innerHTML = records.map(r => {
      const key = r.type === 'MX' ? 'mx' : r.name.startsWith('_dmarc') ? 'dmarc' : r.name.includes('_domainkey') ? 'dkim' : 'spf';
      const ok  = verified?.[key]?.ok;
      return `<div class="dns-record-row">
        <div class="dns-record-meta">
          <span class="badge badge-${r.type === 'MX' ? 'blue' : 'purple'}">${r.type}</span>
          <span class="badge badge-${ok ? 'green' : 'red'}">${ok ? '✓ Verified' : '✗ Not set'}</span>
          <span class="text-secondary text-sm">${r.purpose}</span>
        </div>
        <div class="dns-record-name td-mono text-sm">${r.name}</div>
        <div class="dns-record-value td-mono text-sm">${r.priority ? `Priority: ${r.priority} — ` : ''}${r.value}</div>
      </div>`;
    }).join('');
    modal.classList.add('open');
  }

  // ── Account actions ───────────────────────────────────────────────────────────
  async function addAccount() {
    const email    = document.getElementById('addAccountEmail').value.trim();
    const password = document.getElementById('addAccountPassword').value;
    const quota    = document.getElementById('addAccountQuota').value.trim() || '1G';
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
    const email    = document.getElementById('changePasswordEmail').value;
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

  return {
    switchTab, loadAll, loadAccounts, loadForwards, loadDkim,
    addAccount, addForward, openChangePassword, changePassword,
    confirmDeleteAccount, deleteAccount, deleteForward,
    generateDkim, removeDkim, showDnsRecords,
    openModal, closeModal,
  };
})();
