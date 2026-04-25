// ── Domains module ────────────────────────────────────────────────────────────
window.domains = (() => {
  let currentDomain = null;

  async function load() {
    const tbody = document.getElementById('domainsTable');
    tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state"><p>Loading...</p></div></td></tr>`;
    const data = await api.get('/api/domains');
    if (!data || !data.success) {
      tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state"><p class="text-red">${data?.error || 'Failed to load'}</p></div></td></tr>`;
      return;
    }
    const vhosts = data.data;
    const countEl = document.getElementById('domainCount');
    if (countEl) countEl.textContent = vhosts.length;

    if (!vhosts.length) {
      tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state">
        <div class="empty-state-icon"><svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6.5"/><path d="M8 1.5C8 1.5 6 4 6 8s2 6.5 2 6.5M8 1.5C8 1.5 10 4 10 8s-2 6.5-2 6.5M1.5 8h13"/></svg></div>
        <h4>No domains yet</h4><p>Add your first domain to get started.</p>
      </div></td></tr>`;
      return;
    }

    tbody.innerHTML = vhosts.map(v => `
      <tr>
        <td><span class="font-medium">${v.domain}</span></td>
        <td class="td-mono">${v.docRoot}</td>
        <td>${v.ssl ? '<span class="badge badge-green"><span class="badge-dot"></span>Active</span>' : '<span class="badge badge-muted">None</span>'}</td>
        <td>${v.enabled ? '<span class="badge badge-green"><span class="badge-dot"></span>Enabled</span>' : '<span class="badge badge-red">Disabled</span>'}</td>
        <td>
          <div class="td-actions" style="justify-content:flex-end">
            ${v.enabled
              ? `<button class="btn btn-ghost btn-xs" onclick="domains.toggle('${v.domain}', false)">Disable</button>`
              : `<button class="btn btn-ghost btn-xs" onclick="domains.toggle('${v.domain}', true)">Enable</button>`}
            <button class="btn btn-ghost btn-xs" onclick="domains.openConfig('${v.domain}')">Config</button>
            <button class="btn btn-danger btn-xs" data-confirm-domain="${v.domain}" onclick="domains.confirmDelete(this, '${v.domain}')">Delete</button>
          </div>
        </td>
      </tr>`).join('');
  }

  async function add() {
    const name = document.getElementById('addDomainName').value.trim();
    const root = document.getElementById('addDomainRoot').value.trim();
    if (!name) return toast('error', 'Validation', 'Domain name is required.');
    const btn = document.querySelector('#modalAddDomain .btn-primary');
    btn.classList.add('loading'); btn.disabled = true;
    const data = await api.post('/api/domains', { domain: name, docRoot: root });
    btn.classList.remove('loading'); btn.disabled = false;
    if (data?.success) {
      toast('success', 'Domain added', `${name} vhost created and enabled.`);
      closeModal('modalAddDomain');
      document.getElementById('addDomainName').value = '';
      document.getElementById('addDomainRoot').value = '';
      load();
    } else {
      toast('error', 'Failed', data?.error);
    }
  }

  async function toggle(domain, enable) {
    const url = enable ? `/api/domains/${domain}/enable` : `/api/domains/${domain}/disable`;
    const data = await api.post(url, {});
    if (data?.success) {
      toast('success', enable ? 'Enabled' : 'Disabled', domain);
      load();
    } else {
      toast('error', 'Error', data?.error);
    }
  }

  function confirmDelete(btn, domain) {
    const existing = btn.parentNode.querySelector('.confirm-prompt');
    if (existing) { deleteDomain(domain); return; }
    const prompt = document.createElement('span');
    prompt.className = 'confirm-prompt';
    prompt.textContent = 'Click again to confirm';
    btn.parentNode.insertBefore(prompt, btn);
    setTimeout(() => { if (prompt.parentNode) prompt.remove(); }, 3000);
  }

  async function deleteDomain(domain) {
    const data = await api.del(`/api/domains/${domain}`);
    if (data?.success) { toast('success', 'Deleted', domain); load(); }
    else toast('error', 'Error', data?.error);
  }

  async function openConfig(domain) {
    currentDomain = domain;
    const data = await api.get(`/api/domains/${domain}/config`);
    if (!data?.success) return toast('error', 'Error', data?.error);
    document.getElementById('configDomainName').textContent = domain;
    document.getElementById('configContent').value = data.data;
    openModal('modalViewConfig');
  }

  async function saveConfig() {
    const content = document.getElementById('configContent').value;
    const data = await api.put(`/api/domains/${currentDomain}`, { content });
    if (data?.success) {
      toast('success', 'Config saved', `${currentDomain} reloaded.`);
      closeModal('modalViewConfig');
    } else toast('error', 'Error', data?.error);
  }

  function openAddModal() { openModal('modalAddDomain'); }

  function openModal(id) {
    document.getElementById(id).classList.add('open');
  }
  function closeModal(id) {
    document.getElementById(id).classList.remove('open');
  }

  // Close on backdrop click
  document.querySelectorAll('.modal-backdrop').forEach(m => {
    m.addEventListener('click', e => { if (e.target === m) m.classList.remove('open'); });
  });

  return { load, add, toggle, confirmDelete, openConfig, saveConfig, openAddModal, closeModal, openModal };
})();
