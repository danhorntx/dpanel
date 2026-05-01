'use strict';
window.backupMgr = (() => {
  let _domains = [];

  async function load() {
    const tbody = document.getElementById('backupTable');
    if (tbody) tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state"><p>Loading…</p></div></td></tr>`;

    const [backupData, domainData] = await Promise.all([
      api.get('/api/backup'),
      api.get('/api/domains'),
    ]);

    _domains = domainData?.data || [];
    populateDomainSelect();

    if (!backupData?.success) return toast('error', 'Backups', backupData?.error || 'Failed to load');
    render(backupData.data);
  }

  function populateDomainSelect() {
    const sel = document.getElementById('backupDomain');
    if (!sel) return;
    sel.innerHTML = _domains
      .filter(d => !d.domain.endsWith('-le-ssl'))
      .map(d => `<option value="${d.domain}">${d.domain}</option>`).join('');
  }

  function fmtSize(mb) {
    if (mb < 1) return `${Math.round(mb * 1024)} KB`;
    return `${mb} MB`;
  }

  function render(backups) {
    const tbody = document.getElementById('backupTable');
    if (!backups.length) {
      tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state"><h4>No backups yet</h4><p>Create your first backup using the button above.</p></div></td></tr>`;
      return;
    }
    tbody.innerHTML = backups.map(b => `
      <tr>
        <td><span class="font-medium" style="font-family:var(--font-mono);font-size:0.8125rem">${b.file}</span></td>
        <td><span class="badge ${b.type === 'database' ? 'badge-muted' : 'badge-green'}">${b.type}</span></td>
        <td style="font-size:0.8125rem;color:var(--text-muted)">${fmtSize(b.sizeMb)}</td>
        <td style="font-size:0.8125rem;color:var(--text-muted)">${new Date(b.created).toLocaleString()}</td>
        <td style="text-align:right;display:flex;gap:6px;justify-content:flex-end">
          <a class="btn btn-ghost btn-xs" href="/api/backup/download/${b.file}" download>Download</a>
          <button class="btn btn-danger btn-xs" onclick="window.backupMgr.deleteBackup('${b.file}')">Delete</button>
        </td>
      </tr>`).join('');
  }

  async function createBackup() {
    const domain = document.getElementById('backupDomain').value;
    const type   = document.getElementById('backupType').value;
    if (!domain) return toast('error', 'Validation', 'Select a domain.');
    const btn = document.getElementById('backupCreateBtn');
    btn.disabled = true; btn.textContent = 'Backing up…';
    toast('warning', 'Creating backup…', `${domain} (${type})`);
    const data = await api.post('/api/backup', { domain, type });
    btn.disabled = false; btn.textContent = 'Create Backup';
    if (data?.success) { toast('success', 'Backup created', domain); load(); }
    else toast('error', 'Backup failed', data?.error);
  }

  async function deleteBackup(file) {
    if (!confirm(`Delete backup "${file}"?`)) return;
    const data = await api.del(`/api/backup/${encodeURIComponent(file)}`);
    if (data?.success) { toast('success', 'Deleted', file); load(); }
    else toast('error', 'Failed', data?.error);
  }

  return { load, createBackup, deleteBackup };
})();
