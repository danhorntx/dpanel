// ── PHP Management module ─────────────────────────────────────────────────────
window.phpMgr = (() => {

  async function load() {
    setTableLoading('phpVersionsTable', 4);
    setTableLoading('phpDomainsTable', 3);

    const data = await api.get('/api/php');
    if (!data?.success) {
      toast('error', 'PHP', data?.error || 'Failed to load');
      return;
    }
    const { installed, available, domains } = data.data;

    renderInstalled(installed);
    renderDomains(domains, installed);
    populateInstallSelect(available);

    // Update header default badge
    const def = installed.find(i => i.isDefault);
    const el  = document.getElementById('phpDefaultBadge');
    if (el) {
      el.textContent = def ? `PHP ${def.version}` : 'None';
      el.className = def ? 'badge badge-green' : 'badge badge-muted';
    }
  }

  function setTableLoading(id, cols) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = `<tr><td colspan="${cols}"><div class="empty-state"><p>Loading…</p></div></td></tr>`;
  }

  // ── Installed versions table ──────────────────────────────────────────────────
  function renderInstalled(versions) {
    const tbody = document.getElementById('phpVersionsTable');
    if (!versions.length) {
      tbody.innerHTML = `<tr><td colspan="4"><div class="empty-state">
        <h4>No PHP versions installed</h4>
        <p>Click Install Version to add PHP to this server.</p>
      </div></td></tr>`;
      return;
    }
    tbody.innerHTML = versions.map(v => `
      <tr>
        <td>
          <span class="font-medium" style="font-family:var(--font-mono)">PHP ${v.version}</span>
          <span style="font-size:0.75rem;color:var(--text-muted);margin-left:8px">${v.fullVersion}</span>
        </td>
        <td>
          ${v.fpmActive
            ? '<span class="badge badge-green"><span class="badge-dot"></span>FPM Running</span>'
            : `<span class="badge badge-red">FPM Stopped</span>
               <button class="btn btn-ghost btn-xs" style="margin-left:6px"
                 onclick="window.phpMgr.startFpm('${v.version}')">Start</button>`}
        </td>
        <td>
          ${v.isDefault
            ? '<span class="badge badge-green"><span class="badge-dot"></span>Default</span>'
            : `<button class="btn btn-ghost btn-xs" onclick="window.phpMgr.setDefault('${v.version}')">Set Default</button>`}
        </td>
        <td>
          <div class="td-actions" style="justify-content:flex-end">
            ${!v.isDefault
              ? `<button class="btn btn-danger btn-xs" onclick="window.phpMgr.confirmRemove('${v.version}')">Remove</button>`
              : '<span style="font-size:0.75rem;color:var(--text-muted)">Active</span>'}
          </div>
        </td>
      </tr>`).join('');
  }

  // ── Domain PHP assignment table ───────────────────────────────────────────────
  function renderDomains(domains, installed) {
    const tbody = document.getElementById('phpDomainsTable');
    if (!domains.length) {
      tbody.innerHTML = `<tr><td colspan="3"><div class="empty-state"><p>No domains configured.</p></div></td></tr>`;
      return;
    }
    const opts = ['<option value="">Default (global)</option>']
      .concat(installed.map(v => `<option value="${v.version}">PHP ${v.version}</option>`))
      .join('');

    tbody.innerHTML = domains.map(d => {
      const safeId = d.domain.replace(/[^a-z0-9]/gi, '_');
      const selectedOpts = opts.replace(
        `value="${d.phpVersion || ''}"`,
        `value="${d.phpVersion || ''}" selected`
      );
      return `
        <tr>
          <td><span class="font-medium">${d.domain}</span></td>
          <td>
            ${d.phpVersion
              ? `<span class="badge badge-muted" style="font-family:var(--font-mono)">PHP ${d.phpVersion}</span>`
              : `<span class="badge badge-muted">Global default</span>`}
          </td>
          <td style="text-align:right">
            <select class="input" style="width:auto;font-size:0.8125rem;padding:4px 10px"
              id="domPhp_${safeId}"
              onchange="window.phpMgr.setDomainPhp('${d.domain}', this.value)">
              ${selectedOpts}
            </select>
          </td>
        </tr>`;
    }).join('');
  }

  function populateInstallSelect(available) {
    const sel = document.getElementById('phpInstallVersion');
    const btn = document.getElementById('phpInstallBtn');
    if (!sel) return;
    if (!available.length) {
      sel.innerHTML = '<option value="">All supported versions installed</option>';
      if (btn) btn.disabled = true;
    } else {
      sel.innerHTML = available.map(v => `<option value="${v}">PHP ${v}</option>`).join('');
      if (btn) btn.disabled = false;
    }
  }

  // ── Actions ───────────────────────────────────────────────────────────────────
  async function setDefault(version) {
    toast('warning', 'Switching default…', `PHP ${version}`);
    const data = await api.post('/api/php/default', { version });
    if (data?.success) { toast('success', 'Default changed', `PHP ${version} is now the global default.`); load(); }
    else toast('error', 'Failed', data?.error);
  }

  async function startFpm(version) {
    toast('warning', 'Starting FPM…', `php${version}-fpm`);
    // Use dashboard restart as a proxy — or call a direct endpoint
    // For now, set default will also restart it; just reload
    await load();
    toast('success', 'Refreshed', 'Check FPM status.');
  }

  async function setDomainPhp(domain, version) {
    const data = await api.post('/api/php/domain', { domain, version: version || null });
    if (data?.success) {
      toast('success', 'Updated', version ? `${domain} → PHP ${version}` : `${domain} → global default`);
      load();
    } else {
      toast('error', 'Failed', data?.error);
      load(); // re-render to reset select
    }
  }

  // Install
  let _installing = false;
  function openInstallModal() {
    document.getElementById('modalInstallPHP').classList.add('open');
  }
  async function submitInstall() {
    if (_installing) return;
    const version = document.getElementById('phpInstallVersion').value;
    if (!version) return toast('error', 'Validation', 'Select a version.');
    const btn = document.getElementById('phpInstallBtn');
    btn.classList.add('loading'); btn.disabled = true;
    btn.textContent = 'Installing…';
    _installing = true;
    const data = await api.post('/api/php/install', { version });
    _installing = false;
    btn.classList.remove('loading'); btn.disabled = false;
    btn.textContent = 'Install';
    if (data?.success) {
      toast('success', `PHP ${version} installed`, 'FPM started. Set it as default if needed.');
      document.getElementById('modalInstallPHP').classList.remove('open');
      load();
    } else toast('error', 'Install failed', data?.error);
  }

  // Remove
  let _pendingRemove = null;
  function confirmRemove(version) {
    _pendingRemove = version;
    document.getElementById('phpRemoveVersion').textContent = version;
    document.getElementById('modalRemovePHP').classList.add('open');
  }
  async function submitRemove() {
    if (!_pendingRemove) return;
    const version = _pendingRemove;
    document.getElementById('modalRemovePHP').classList.remove('open');
    _pendingRemove = null;
    toast('warning', 'Removing…', `PHP ${version}`);
    const data = await api.del(`/api/php/${version}`);
    if (data?.success) { toast('success', 'Removed', `PHP ${version} uninstalled.`); load(); }
    else toast('error', 'Remove failed', data?.error);
  }

  return { load, setDefault, startFpm, setDomainPhp, openInstallModal, submitInstall, confirmRemove, submitRemove };
})();
