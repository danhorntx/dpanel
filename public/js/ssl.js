// ── SSL module ────────────────────────────────────────────────────────────────
window.ssl = (() => {

  function daysClass(days) {
    if (days === null) return 'badge-muted';
    if (days < 10)  return 'badge-red';
    if (days < 30)  return 'badge-amber';
    return 'badge-green';
  }

  async function load() {
    const tbody = document.getElementById('sslTable');
    tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state"><p>Loading...</p></div></td></tr>`;
    const data = await api.get('/api/ssl');
    if (!data?.success) {
      tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state"><p class="text-red">${data?.error || 'Failed'}</p></div></td></tr>`;
      return;
    }
    if (!data.data.length) {
      tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state">
        <h4>No certificates found</h4>
        <p>Request a Let's Encrypt cert or check /etc/letsencrypt/live</p>
      </div></td></tr>`;
      return;
    }
    tbody.innerHTML = data.data.map(c => `
      <tr>
        <td><span class="font-medium">${c.domain}</span></td>
        <td><span class="badge badge-muted">${c.type}</span></td>
        <td class="td-mono text-secondary text-xs">${c.issuer}</td>
        <td class="td-mono text-sm">${c.expiry || '—'}</td>
        <td><span class="badge ${daysClass(c.daysLeft)}">${c.daysLeft !== null ? c.daysLeft + 'd' : '—'}</span></td>
        <td>
          <div class="td-actions" style="justify-content:flex-end">
            <button class="btn btn-ghost btn-xs" onclick="ssl.renew('${c.domain}')">Renew</button>
          </div>
        </td>
      </tr>`).join('');
  }

  async function renew(domain) {
    toast('warning', 'Renewing...', domain);
    const data = await api.post(`/api/ssl/renew/${domain}`, {});
    if (data?.success) { toast('success', 'Renewed', domain); load(); }
    else toast('error', 'Renew failed', data?.error);
  }

  async function renewAll() {
    toast('warning', 'Renewing all certs...');
    const data = await api.post('/api/ssl/renew-all', {});
    if (data?.success) { toast('success', 'All certs renewed'); load(); }
    else toast('error', 'Renew failed', data?.error);
  }

  async function request() {
    const domains = document.getElementById('sslDomains').value.trim();
    const webroot = document.getElementById('sslWebroot').value.trim();
    if (!domains || !webroot) return toast('error', 'Validation', 'Domains and webroot are required.');
    const btn = document.getElementById('sslRequestBtn');
    btn.classList.add('loading'); btn.disabled = true;
    btn.textContent = 'Requesting...';
    const data = await api.post('/api/ssl/request', { domains, webroot });
    btn.classList.remove('loading'); btn.disabled = false;
    btn.textContent = 'Request Certificate';
    if (data?.success) {
      toast('success', 'Certificate issued', domains);
      closeModal();
      document.getElementById('sslDomains').value = '';
      document.getElementById('sslWebroot').value = '';
      load();
    } else toast('error', 'Certbot error', data?.error);
  }

  function openRequestModal() { document.getElementById('modalRequestSSL').classList.add('open'); }
  function closeModal() { document.getElementById('modalRequestSSL').classList.remove('open'); }

  return { load, renew, renewAll, request, openRequestModal, closeModal };
})();
