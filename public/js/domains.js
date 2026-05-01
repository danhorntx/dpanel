// ── Domains module ────────────────────────────────────────────────────────────
window.domains = (() => {
  let currentDomain  = null;
  let pendingDelete  = null;
  let _certMap       = {};   // domain → { daysLeft, expiry }

  // ── SSL cert badge helper ─────────────────────────────────────────────────
  function sslBadge(v) {
    if (!v.ssl) return '<span class="badge badge-muted">None</span>';
    const cert = _certMap[v.domain];
    if (!cert) return '<span class="badge badge-green"><span class="badge-dot"></span>Active</span>';
    const d = cert.daysLeft;
    if (d === null || d === undefined) return '<span class="badge badge-green"><span class="badge-dot"></span>Active</span>';
    if (d < 14) return `<span class="badge badge-red" title="Expires in ${d} day${d===1?'':'s'}"><span class="badge-dot"></span>${d}d left</span>`;
    if (d < 30) return `<span class="badge badge-amber" title="Expires in ${d} days"><span class="badge-dot"></span>${d}d left</span>`;
    return `<span class="badge badge-green" title="Expires in ${d} days"><span class="badge-dot"></span>Active</span>`;
  }

  async function load() {
    const tbody = document.getElementById('domainsTable');
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><p>Loading...</p></div></td></tr>`;

    // Fetch domains + certs in parallel
    const [data, certData] = await Promise.all([
      api.get('/api/domains'),
      api.get('/api/ssl').catch(() => null),
    ]);

    // Build cert lookup map
    _certMap = {};
    if (certData?.success) {
      for (const c of certData.data) {
        // LE certs directory name may be "domain.com-0001" etc — normalise
        const key = c.domain.replace(/-\d+$/, '');
        _certMap[key] = c;
      }
    }

    if (!data || !data.success) {
      tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><p class="text-red">${data?.error || 'Failed to load'}</p></div></td></tr>`;
      return;
    }
    const vhosts = data.data;
    const countEl = document.getElementById('domainCount');
    if (countEl) countEl.textContent = vhosts.length;

    if (!vhosts.length) {
      tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state">
        <div class="empty-state-icon"><svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6.5"/><path d="M8 1.5C8 1.5 6 4 6 8s2 6.5 2 6.5M8 1.5C8 1.5 10 4 10 8s-2 6.5-2 6.5M1.5 8h13"/></svg></div>
        <h4>No domains yet</h4><p>Add your first domain to get started.</p>
      </div></td></tr>`;
      return;
    }

    tbody.innerHTML = vhosts.map(v => `
      <tr>
        <td class="td-truncate" title="${v.domain}"><span class="font-medium">${v.domain}</span></td>
        <td class="td-mono td-truncate" title="${v.docRoot}">${v.docRoot}</td>
        <td>${sslBadge(v)}</td>
        <td id="disk-${v.domain.replace(/\./g, '-')}" class="text-secondary text-sm">
          <span class="text-muted">—</span>
        </td>
        <td>${v.enabled ? '<span class="badge badge-green"><span class="badge-dot"></span>Enabled</span>' : '<span class="badge badge-red">Disabled</span>'}</td>
        <td>
          <div class="td-actions">
            ${v.enabled
              ? `<button class="btn btn-ghost btn-xs" onclick="window.domains.toggle('${v.domain}', false)">Disable</button>`
              : `<button class="btn btn-ghost btn-xs" onclick="window.domains.toggle('${v.domain}', true)">Enable</button>`}
            <button class="btn btn-ghost btn-xs" onclick="window.ftp.openForDomain('${v.domain}', '${v.docRoot}')">Access</button>
            <button class="btn btn-ghost btn-xs" onclick="window.domains.openLogs('${v.domain}')">Logs</button>
            <button class="btn btn-ghost btn-xs" onclick="window.domains.openRedirects('${v.domain}')">Redirects</button>
            <button class="btn btn-ghost btn-xs" onclick="window.domains.openConfig('${v.domain}')">Config</button>
            <button class="btn btn-danger btn-xs" onclick="window.domains.confirmDelete('${v.domain}')">Delete</button>
          </div>
        </td>
      </tr>`).join('');

    // Lazy-load disk usage in background (non-blocking)
    loadDiskUsage(vhosts);
  }

  // ── Lazy disk usage loader ────────────────────────────────────────────────
  async function loadDiskUsage(vhosts) {
    for (const v of vhosts) {
      const cellId = `disk-${v.domain.replace(/\./g, '-')}`;
      const cell = document.getElementById(cellId);
      if (!cell) continue;
      try {
        const d = await api.get(`/api/domains/${v.domain}/diskusage`);
        if (d?.success) cell.textContent = d.data.size;
      } catch (_) {}
      // Small delay between requests to avoid hammering the server
      await new Promise(r => setTimeout(r, 80));
    }
  }

  // ── Domain error log viewer ───────────────────────────────────────────────
  async function openLogs(domain) {
    const modal = document.getElementById('modalDomainLogs');
    if (!modal) return;
    document.getElementById('logsModalDomain').textContent = domain;
    document.getElementById('logsModalContent').textContent = 'Loading…';
    document.getElementById('logsModalTab').dataset.current = 'error';
    _setLogsTab(modal, 'error');
    openModal('modalDomainLogs');
    await fetchLogs(domain, 'error');
  }

  async function fetchLogs(domain, type) {
    const content = document.getElementById('logsModalContent');
    content.textContent = 'Loading…';
    const endpoint = type === 'access'
      ? `/api/logs/domain/${domain}/access`
      : `/api/logs/domain/${domain}`;
    const data = await api.get(endpoint);
    if (!data?.success) {
      content.textContent = `Error: ${data?.error}`;
      return;
    }
    if (!data.data.length) {
      content.textContent = data.note || 'No log entries found.';
      return;
    }
    content.textContent = data.data.join('\n');
    // Scroll to bottom
    content.parentElement.scrollTop = content.parentElement.scrollHeight;
  }

  function _setLogsTab(modal, type) {
    modal.querySelectorAll('.logs-tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.logType === type);
    });
  }

  function switchLogsTab(type) {
    const modal = document.getElementById('modalDomainLogs');
    if (!modal) return;
    _setLogsTab(modal, type);
    const domain = document.getElementById('logsModalDomain').textContent;
    fetchLogs(domain, type);
  }

  // ── Setup-complete credentials modal ─────────────────────────────────────────
  function add() {
    const name        = document.getElementById('addDomainName').value.trim();
    const root        = document.getElementById('addDomainRoot').value.trim();
    const mailDns     = document.getElementById('addDomainMailDns')?.checked || false;
    if (!name) return toast('error', 'Validation', 'Domain name is required.');
    _doAdd(name, root, mailDns);
  }

  async function _doAdd(name, root, mailDns) {
    const btn = document.querySelector('#modalAddDomain .btn-primary');
    btn.classList.add('loading'); btn.disabled = true;
    btn.textContent = 'Creating domain…';

    const sslMsg = setTimeout(() => {
      if (btn.disabled) btn.textContent = 'Requesting SSL…';
    }, 4000);

    const data = await api.post('/api/domains', { domain: name, docRoot: root, setupMailDns: mailDns });
    clearTimeout(sslMsg);
    btn.classList.remove('loading'); btn.disabled = false;
    btn.textContent = 'Create Domain';

    if (data?.success) {
      closeModal('modalAddDomain');
      document.getElementById('addDomainName').value = '';
      document.getElementById('addDomainRoot').value = '';
      document.getElementById('addDomainMailDns').checked = false;
      load();
      showCredentials(data.credentials);
    } else {
      toast('error', 'Failed', data?.error);
    }
  }

  function showCredentials(c) {
    if (!c) return;

    document.getElementById('credDomain').textContent = c.domain || '—';

    const sslEl = document.getElementById('credSSLStatus');
    if (c.sslStatus === 'active') {
      sslEl.innerHTML = '<span class="badge badge-green"><span class="badge-dot"></span>SSL Active — HTTPS ready</span>';
    } else if (c.sslStatus === 'failed') {
      const errSnip = (c.sslError || '').slice(0, 160);
      sslEl.innerHTML = `<span class="badge badge-red">SSL Failed</span>
        <p style="font-size:0.75rem;color:var(--text-muted);margin-top:6px;font-family:var(--font-mono);white-space:pre-wrap;word-break:break-all">${errSnip}</p>
        <p style="font-size:0.75rem;color:var(--text-secondary);margin-top:4px">Go to <strong>SSL Certs → AutoSSL</strong> once DNS fully propagates.</p>`;
    } else {
      sslEl.innerHTML = '<span class="badge badge-muted">SSL Pending</span>';
    }

    const mailDnsEl = document.getElementById('credMailDnsStatus');
    if (c.mailDns) {
      mailDnsEl.style.display = '';
      if (c.mailDns.applied) {
        mailDnsEl.innerHTML = '<span class="badge badge-green"><span class="badge-dot"></span>Mail DNS configured — MX, SPF, and DMARC records added</span>';
      } else {
        const note = c.mailDns.message || c.mailDns.error || 'DNS zone not found';
        mailDnsEl.innerHTML = `<span class="badge badge-amber">Mail DNS pending</span>
          <p style="font-size:0.75rem;color:var(--text-muted);margin-top:6px">${note} — you can configure it later under <strong style="color:var(--text-secondary)">Mail → DNS Setup</strong>.</p>`;
      }
    } else {
      mailDnsEl.style.display = 'none';
    }

    const credsSection = document.getElementById('credsSFTPSection');
    const errEl = document.getElementById('credAccountError');
    errEl.style.display = 'none';

    if (c.username) {
      document.getElementById('credHost').textContent     = c.host || '—';
      document.getElementById('credPort').textContent     = c.port || 22;
      document.getElementById('credUsername').textContent = c.username;
      document.getElementById('credPassword').textContent = c.password;
      document.getElementById('credDocRoot').textContent  = c.docRoot || '—';
      credsSection.style.display = '';
    } else {
      credsSection.style.display = 'none';
      if (c.accountError) {
        errEl.textContent = 'SFTP account error: ' + c.accountError;
        errEl.style.display = '';
      }
    }

    openModal('modalSetupComplete');
  }

  function copyCredField(id) {
    const val = document.getElementById(id)?.textContent || '';
    navigator.clipboard.writeText(val)
      .then(() => toast('success', 'Copied', ''))
      .catch(() => {});
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

  function confirmDelete(domain) {
    pendingDelete = domain;
    document.getElementById('deleteDomainDisplay').textContent = domain;
    document.getElementById('deleteDomainLabel').textContent   = domain;
    document.getElementById('deleteDomainInput').value         = '';
    const btn = document.getElementById('deleteDomainConfirmBtn');
    btn.disabled = true;
    btn.style.opacity = '0.4';
    openModal('modalDeleteDomain');
    setTimeout(() => document.getElementById('deleteDomainInput').focus(), 120);
  }

  function checkDeleteInput() {
    const val = document.getElementById('deleteDomainInput').value.trim();
    const btn = document.getElementById('deleteDomainConfirmBtn');
    const match = (val === pendingDelete);
    btn.disabled      = !match;
    btn.style.opacity = match ? '1' : '0.4';
  }

  async function submitDelete() {
    if (!pendingDelete) return;
    const data = await api.del(`/api/domains/${pendingDelete}`);
    if (data?.success) {
      toast('success', 'Deleted', pendingDelete);
      closeModal('modalDeleteDomain');
      pendingDelete = null;
      load();
    } else {
      toast('error', 'Error', data?.error);
    }
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

  // ── Dynamic DNS preview in Add Domain modal ───────────────────────────────────
  function updateDnsPreview(value) {
    const host = (value || '').trim().toLowerCase().replace(/^https?:\/\//, '');
    const parts = host.split('.').filter(Boolean);
    const isSubdomain = parts.length > 2;

    const name1El   = document.getElementById('dnsName1');
    const name2El   = document.getElementById('dnsName2');
    const row2El    = document.getElementById('dnsRow2');
    const titleEl   = document.getElementById('dnsCalloutTitle');
    const descEl    = document.getElementById('dnsCalloutDesc');

    if (isSubdomain) {
      const sub = parts.slice(0, parts.length - 2).join('.');
      if (name1El) name1El.textContent = sub;
      if (row2El)  row2El.style.display = 'none';
      if (titleEl) titleEl.textContent = `Point ${host} to this server first`;
      if (descEl)  descEl.innerHTML = `Add this <strong style="color:var(--text-primary)">A record</strong> at your registrar for the <strong style="color:var(--text-primary)">${parts.slice(-2).join('.')}</strong> zone. No nameserver change needed.`;
    } else {
      if (name1El) name1El.textContent = '@';
      if (name2El) name2El.textContent = 'www';
      if (row2El)  row2El.style.display = 'grid';
      if (titleEl) titleEl.textContent = host ? `Point ${host} to this server first` : 'Point your domain to this server first';
      if (descEl)  descEl.innerHTML = `At your registrar (GoDaddy, Namecheap, etc.), add these <strong style="color:var(--text-primary)">DNS A records</strong>. You don't need to change nameservers.`;
    }
  }

  // ── Redirects manager ─────────────────────────────────────────────────────
  let _redirectDomain = null;

  async function openRedirects(domain) {
    _redirectDomain = domain;
    document.getElementById('redirectModalDomain').textContent = domain;
    document.getElementById('redirectFrom').value  = '';
    document.getElementById('redirectTo').value    = '';
    document.getElementById('redirectType').value  = '301';
    openModal('modalRedirects');
    await loadRedirects();
  }

  async function loadRedirects() {
    const tbody = document.getElementById('redirectsTable');
    if (!tbody || !_redirectDomain) return;
    tbody.innerHTML = '<tr><td colspan="4"><div class="empty-state"><p>Loading…</p></div></td></tr>';
    const data = await api.get(`/api/domains/${_redirectDomain}/redirects`);
    if (!data?.success) {
      tbody.innerHTML = `<tr><td colspan="4"><div class="empty-state"><p class="text-red">${data?.error}</p></div></td></tr>`;
      return;
    }
    if (!data.data.length) {
      tbody.innerHTML = '<tr><td colspan="4"><div class="empty-state"><p>No redirects yet.</p></div></td></tr>';
      return;
    }
    tbody.innerHTML = data.data.map(r => `
      <tr>
        <td class="td-mono text-sm">${r.from_path}</td>
        <td class="td-mono text-sm td-truncate" title="${r.to_url}">${r.to_url}</td>
        <td><span class="badge badge-${r.type === 301 ? 'blue' : 'amber'}">${r.type}</span></td>
        <td><button class="btn btn-danger btn-xs" onclick="window.domains.deleteRedirect(${r.id})">Remove</button></td>
      </tr>`).join('');
  }

  async function addRedirect() {
    const from_path = document.getElementById('redirectFrom').value.trim();
    const to_url    = document.getElementById('redirectTo').value.trim();
    const type      = parseInt(document.getElementById('redirectType').value, 10);
    if (!from_path || !to_url) return toast('error', 'Validation', 'From path and To URL are required');
    const data = await api.post(`/api/domains/${_redirectDomain}/redirects`, { from_path, to_url, type });
    if (data?.success) {
      document.getElementById('redirectFrom').value = '';
      document.getElementById('redirectTo').value   = '';
      toast('success', 'Redirect added', `${from_path} → ${to_url}`);
      loadRedirects();
    } else {
      toast('error', 'Error', data?.error);
    }
  }

  async function deleteRedirect(id) {
    const data = await api.del(`/api/domains/${_redirectDomain}/redirects/${id}`);
    if (data?.success) { toast('success', 'Removed', ''); loadRedirects(); }
    else toast('error', 'Error', data?.error);
  }

  function openAddModal() {
    updateDnsPreview('');
    openModal('modalAddDomain');
  }

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

  return {
    load, add, toggle, confirmDelete, checkDeleteInput, submitDelete,
    openConfig, saveConfig, openAddModal, updateDnsPreview, showCredentials,
    copyCredField, closeModal, openModal, openLogs, switchLogsTab,
    openRedirects, loadRedirects, addRedirect, deleteRedirect,
  };
})();
