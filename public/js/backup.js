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
          <button class="btn btn-ghost btn-xs"  onclick="window.backupMgr.openRestore('${b.file}','${b.type}')">Restore</button>
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

  // ── Restore ──────────────────────────────────────────────────────────────
  let _restore = null;  // { file, type, target }

  function openRestore(file, type) {
    _restore = { file, type };
    document.getElementById('restoreFilename').textContent = file;
    document.getElementById('restoreType').textContent      = type;

    // Derive a likely target from the filename. Backup names are
    //   <prefix>_(files|db)_<ts>.(tar.gz|sql.gz) — the prefix is the domain
    //   (for files) or the database name (for databases).
    const prefix = file.split('_')[0];

    // Show the right input pair for the backup type
    const filesGroup = document.getElementById('restoreFilesGroup');
    const dbGroup    = document.getElementById('restoreDbGroup');
    if (type === 'files') {
      filesGroup.style.display = '';
      dbGroup.style.display    = 'none';
      // Build domain dropdown from cached list, pre-select prefix match
      const sel = document.getElementById('restoreDomain');
      sel.innerHTML = _domains
        .filter(d => !d.domain.endsWith('-le-ssl'))
        .map(d => `<option value="${d.domain}" ${d.domain === prefix ? 'selected' : ''}>${d.domain}</option>`)
        .join('');
      document.getElementById('restoreWipe').checked = true;
    } else {
      filesGroup.style.display = 'none';
      dbGroup.style.display    = '';
      document.getElementById('restoreDbName').value = prefix;
      document.getElementById('restoreDropFirst').checked = true;
    }

    document.getElementById('restoreConfirmInput').value = '';
    document.getElementById('restoreBtn').disabled = true;
    document.getElementById('modalRestoreBackup').classList.add('open');
    setTimeout(() => document.getElementById('restoreConfirmInput').focus(), 80);
  }

  function checkRestoreConfirm() {
    const val = document.getElementById('restoreConfirmInput').value.trim();
    document.getElementById('restoreBtn').disabled = (val !== 'RESTORE');
  }

  async function submitRestore() {
    if (!_restore) return;
    const btn = document.getElementById('restoreBtn');
    btn.disabled = true; btn.textContent = 'Restoring…';
    let data;
    if (_restore.type === 'files') {
      const domain = document.getElementById('restoreDomain').value;
      const wipe   = document.getElementById('restoreWipe').checked;
      data = await api.post('/api/backup/restore/files', { file: _restore.file, domain, wipe });
    } else {
      const database  = document.getElementById('restoreDbName').value.trim();
      const dropFirst = document.getElementById('restoreDropFirst').checked;
      if (!database) { btn.textContent = 'Restore'; return toast('error', 'Validation', 'Target database name required.'); }
      data = await api.post('/api/backup/restore/database', { file: _restore.file, database, dropFirst });
    }
    btn.disabled = false; btn.textContent = 'Restore';
    if (data?.success) {
      toast('success', 'Restored', _restore.file);
      document.getElementById('modalRestoreBackup').classList.remove('open');
      _restore = null;
    } else {
      toast('error', 'Restore failed', data?.error);
    }
  }

  function cancelRestore() {
    document.getElementById('modalRestoreBackup').classList.remove('open');
    _restore = null;
  }

  return { load, createBackup, deleteBackup, openRestore, checkRestoreConfirm, submitRestore, cancelRestore };
})();
