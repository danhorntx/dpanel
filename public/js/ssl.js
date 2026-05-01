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
        <p>Add a domain — SSL is issued automatically. Or use Request Cert for a manual setup.</p>
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
            <button class="btn btn-ghost btn-xs" title="Standard renewal — only runs if within 30-day window"
              onclick="window.ssl.renew('${c.domain}')">Renew</button>
            <button class="btn btn-ghost btn-xs" title="Force-issue a fresh cert right now"
              onclick="window.ssl.reissue('${c.domain}')">Reissue</button>
            <button class="btn btn-danger btn-xs" title="Delete this cert and renewal config from the server"
              onclick="window.ssl.confirmRevoke('${c.domain}')">Remove</button>
          </div>
        </td>
      </tr>`).join('');
  }

  // ── Renew (standard — skips if not within window) ────────────────────────────
  async function renew(domain) {
    toast('warning', 'Renewing…', domain);
    const data = await api.post(`/api/ssl/renew/${domain}`, {});
    if (data?.success) { toast('success', 'Renewed', domain); load(); }
    else toast('error', 'Renew failed', data?.error);
  }

  // ── Renew All ─────────────────────────────────────────────────────────────────
  async function renewAll() {
    toast('warning', 'Renewing all certs…');
    const data = await api.post('/api/ssl/renew-all', {});
    if (data?.success) { toast('success', 'All certs renewed'); load(); }
    else toast('error', 'Renew failed', data?.error);
  }

  // ── Reissue — force full reissue via certbot --apache ────────────────────────
  async function reissue(domain) {
    const btn = document.activeElement;
    if (btn && btn.tagName === 'BUTTON') { btn.classList.add('loading'); btn.disabled = true; }
    toast('warning', 'Reissuing…', `Requesting a fresh cert for ${domain}`);
    const data = await api.post(`/api/ssl/reissue/${domain}`, {});
    if (btn && btn.tagName === 'BUTTON') { btn.classList.remove('loading'); btn.disabled = false; }
    if (data?.success) { toast('success', 'Reissued', domain); load(); }
    else toast('error', 'Reissue failed', data?.error);
  }

  // ── Remove cert — confirmation modal ─────────────────────────────────────────
  let _pendingRevoke = null;
  function confirmRevoke(domain) {
    _pendingRevoke = domain;
    document.getElementById('revokeModalDomain').textContent = domain;
    document.getElementById('modalRevokeSSL').classList.add('open');
  }
  async function submitRevoke() {
    if (!_pendingRevoke) return;
    const domain = _pendingRevoke;
    document.getElementById('modalRevokeSSL').classList.remove('open');
    _pendingRevoke = null;
    toast('warning', 'Removing cert…', domain);
    const data = await api.del(`/api/ssl/revoke/${domain}`);
    if (data?.success) { toast('success', 'Cert removed', domain); load(); }
    else toast('error', 'Remove failed', data?.error);
  }

  // ── Manual request modal ──────────────────────────────────────────────────────
  async function request() {
    const domains = document.getElementById('sslDomains').value.trim();
    const webroot = document.getElementById('sslWebroot').value.trim();
    if (!domains || !webroot) return toast('error', 'Validation', 'Domains and webroot are required.');
    const btn = document.getElementById('sslRequestBtn');
    btn.classList.add('loading'); btn.disabled = true;
    btn.textContent = 'Requesting…';
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

  // ── AutoSSL modal ─────────────────────────────────────────────────────────────
  function openAutoModal() {
    document.getElementById('autoSSLDomain').value = '';
    document.getElementById('modalAutoSSL').classList.add('open');
  }
  async function runAutoSSL() {
    const domain = document.getElementById('autoSSLDomain').value.trim();
    if (!domain) return toast('error', 'Validation', 'Domain is required.');
    const btn = document.getElementById('autoSSLBtn');
    btn.classList.add('loading'); btn.disabled = true;
    btn.textContent = 'Requesting…';
    const data = await api.post(`/api/ssl/auto/${domain}`, {});
    btn.classList.remove('loading'); btn.disabled = false;
    btn.textContent = 'Issue Certificate';
    if (data?.success) {
      toast('success', 'SSL issued', domain);
      document.getElementById('modalAutoSSL').classList.remove('open');
      load();
    } else toast('error', 'AutoSSL failed', data?.error);
  }

  function openRequestModal() { document.getElementById('modalRequestSSL').classList.add('open'); }
  function closeModal()       { document.getElementById('modalRequestSSL').classList.remove('open'); }

  return { load, renew, renewAll, reissue, confirmRevoke, submitRevoke, request, openAutoModal, runAutoSSL, openRequestModal, closeModal };
})();
