// public/js/access.js — SSH-first per-domain Access modal.
//
// Replaces the legacy window.ftp.openForDomain path. One key-managed
// deploy user per domain; SFTP/shell are opt-in fallbacks. Auto-adopts
// any legacy domain (no row in dpanel_sftp_accounts) on first open.

window.access = (() => {
  const api = window.api;
  const toast = window.toast;

  // ── State held only while the modal is open ───────────────────────────────
  let _state = {
    domain:      null,
    data:        null,   // last GET /access payload
    pendingKey:  null,   // { privateKey, publicKey } from a generate call
    collisionUsername: null,
  };

  // ── Open / close ──────────────────────────────────────────────────────────
  async function open(domain) {
    _state = { domain, data: null, pendingKey: null, collisionUsername: null };
    document.getElementById('accessModalDomain').textContent = domain;
    document.getElementById('accessLoading').style.display    = '';
    document.getElementById('accessError').style.display      = 'none';
    document.getElementById('accessUsernameCollision').style.display = 'none';
    document.getElementById('accessContent').style.display    = 'none';
    document.getElementById('accessGenKeyCard').style.display = 'none';
    window.domains?.openModal?.('modalDomainAccess')
      || document.getElementById('modalDomainAccess').classList.add('open');

    await _loadAndRender();
  }

  function close() {
    // Force-dismiss the pending private key if the user closes without saving.
    _state.pendingKey = null;
    window.domains?.closeModal?.('modalDomainAccess')
      || document.getElementById('modalDomainAccess').classList.remove('open');
  }

  // ── Load + auto-adopt + render ────────────────────────────────────────────
  async function _loadAndRender() {
    try {
      const res = await api.get(`/api/domains/${_state.domain}/access`);
      if (!res)              return _showError('Network error — could not reach DPanel.');
      if (!res.success)      return _showError(res.error || 'Failed to load access info.');
      if (!res.data)         return _showError('Server returned an empty response.');

      // Auto-adopt if no key-managed deploy user exists yet for this domain.
      if (!res.data.account) {
        const adopt = await api.post(`/api/domains/${_state.domain}/access/adopt`, { sshKeys: [] });
        if (!adopt?.success) {
          if (adopt?.code === 'username-taken' || /reserved|already exists/i.test(adopt?.error || '')) {
            return _showCollision(adopt.error);
          }
          return _showError(adopt?.error || 'Could not initialise deploy user.');
        }
        const res2 = await api.get(`/api/domains/${_state.domain}/access`);
        if (!res2?.success || !res2.data?.account) return _showError('Adoption succeeded but reload failed.');
        _state.data = res2.data;
      } else {
        _state.data = res.data;
      }
      _render();
    } catch (err) {
      console.error('[access] load failed:', err);
      _showError(err?.message || 'Unexpected error loading access info.');
    }
  }

  function _showError(msg) {
    document.getElementById('accessLoading').style.display = 'none';
    document.getElementById('accessContent').style.display = 'none';
    const el = document.getElementById('accessError');
    el.textContent = msg;
    el.style.display = '';
  }

  function _showCollision(msg) {
    document.getElementById('accessLoading').style.display = 'none';
    document.getElementById('accessContent').style.display = 'none';
    document.getElementById('accessCollisionMsg').textContent = msg;
    document.getElementById('accessUsernameCollision').style.display = '';
  }

  async function retryAdopt() {
    const username = document.getElementById('accessCollisionInput').value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (!username) return toast('error', 'Required', 'Enter a username.');
    const adopt = await api.post(`/api/domains/${_state.domain}/access/adopt`, { sshKeys: [], username });
    if (!adopt?.success) return toast('error', 'Failed', adopt?.error || 'Adoption failed.');
    document.getElementById('accessUsernameCollision').style.display = 'none';
    document.getElementById('accessLoading').style.display = '';
    await _loadAndRender();
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  function _render() {
    const d = _state.data;
    if (!d?.account) return _showError('No deploy user found.');

    document.getElementById('accessLoading').style.display = 'none';
    document.getElementById('accessContent').style.display = '';
    document.getElementById('accessError').style.display   = 'none';

    _renderConnection(d.account, d.vhost);
    _renderKeys(d.keys || []);
    _renderToggles(d.account, d.placeholder);
    _renderSsl(d.ssl);
    _renderLegacy(d.legacyAccounts || []);
  }

  function _renderConnection(account, vhost) {
    const host = location.hostname.replace(/^panel\./, '');
    const rows = [
      { label: 'Host',     id: 'conn-host',     value: host },
      { label: 'Port',     id: 'conn-port',     value: 22 },
      { label: 'Username', id: 'conn-username', value: account.username, accent: true },
      { label: 'Path',     id: 'conn-docroot',  value: account.doc_root || vhost?.docRoot || '—' },
    ];
    document.getElementById('accessConnection').innerHTML = rows.map(r => `
      <div class="access-row">
        <span class="label">${r.label}</span>
        <span class="value" id="${r.id}"${r.accent ? ' style="color:var(--accent)"' : ''}>${_esc(r.value)}</span>
        <button class="btn btn-ghost btn-xs" onclick="window.access.copyField('${r.id}')">Copy</button>
      </div>
    `).join('');
  }

  function _renderKeys(keys) {
    const ul = document.getElementById('accessKeysList');
    if (!keys.length) {
      ul.innerHTML = `<li style="font-size:0.8125rem;color:var(--text-muted);padding:var(--space-3);background:var(--bg-base);border:1px dashed var(--border);border-radius:var(--radius-sm);text-align:center">No keys yet — add one below to enable SSH access.</li>`;
      return;
    }
    ul.innerHTML = keys.map(k => `
      <li style="display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius-sm)">
        <div style="flex:1;min-width:0">
          <div style="font-size:0.8125rem;color:var(--text-primary)">${_esc(k.label || 'key')}</div>
          <div style="font-size:0.7rem;color:var(--text-muted);font-family:var(--font-mono);overflow:hidden;text-overflow:ellipsis">${_esc(k.key_type)} · ${_esc(k.fingerprint)}</div>
        </div>
        <button class="btn btn-ghost btn-xs" onclick="window.access.removeKey('${encodeURIComponent(k.fingerprint)}')" style="color:var(--text-error, #e05c6a)">Remove</button>
      </li>
    `).join('');
  }

  function _renderToggles(account, placeholder) {
    document.getElementById('accessFtpToggle').checked   = !!account.ftp_enabled;
    document.getElementById('accessFtpBox').style.display = account.ftp_enabled ? '' : 'none';
    document.getElementById('accessShellToggle').checked = !!account.allow_shell;
    document.getElementById('accessPlaceholderToggle').checked = !!placeholder?.enabled;
  }

  function _renderSsl(ssl) {
    const ul = document.getElementById('accessSslList');
    const hosts = ssl?.hosts || [];
    if (!hosts.length) {
      ul.innerHTML = `<li style="color:var(--text-muted);padding:var(--space-2)">No SSL attempts recorded yet.</li>`;
      return;
    }
    ul.innerHTML = hosts.map(h => {
      const badge = h.success
        ? `<span class="badge badge-green"><span class="badge-dot"></span>Active</span>`
        : (h.retriesRemaining > 0
            ? `<span class="badge badge-amber">Pending (${h.attempts} attempts, ${h.retriesRemaining} left)</span>`
            : `<span class="badge badge-red">Failed</span>`);
      const retryBtn = h.success ? '' : `<button class="btn btn-ghost btn-xs" onclick="window.access.retrySsl('${_esc(h.host)}')">Retry now</button>`;
      const err = h.lastError ? `<div style="font-size:0.7rem;color:var(--text-muted);margin-top:2px;font-family:var(--font-mono)">${_esc(h.lastError.slice(0, 160))}</div>` : '';
      return `
        <li style="padding:8px 10px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius-sm)">
          <div style="display:flex;align-items:center;gap:8px">
            <span style="flex:1;font-family:var(--font-mono);color:var(--text-primary)">${_esc(h.host)}</span>
            ${badge}
            ${retryBtn}
          </div>
          ${err}
        </li>
      `;
    }).join('');
  }

  function _renderLegacy(legacy) {
    const section = document.getElementById('accessLegacySection');
    if (!legacy.length) { section.style.display = 'none'; return; }
    section.style.display = '';
    document.getElementById('accessLegacyList').innerHTML = legacy.map(a => `
      <li style="display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius-sm)">
        <div style="flex:1">
          <div style="font-family:var(--font-mono);color:var(--text-primary)">${_esc(a.username)}</div>
          <div style="font-size:0.7rem;color:var(--text-muted)">${a.allowShell ? 'shell' : 'sftp-only'} · ${a.hasSshKey ? 'has key' : 'password'} · ${a.ftpEnabled ? 'ftp' : 'no ftp'}</div>
        </div>
        <button class="btn btn-ghost btn-xs" onclick="window.access.removeLegacy('${_esc(a.username)}')" style="color:var(--text-error, #e05c6a)">Remove</button>
      </li>
    `).join('');
  }

  // ── Actions ────────────────────────────────────────────────────────────────
  async function submitKey() {
    const label    = document.getElementById('accessAddKeyLabel').value.trim() || 'key';
    const publicKey = document.getElementById('accessAddKeyText').value.trim();
    if (!publicKey) return toast('error', 'Required', 'Paste a public key.');
    const res = await api.post(`/api/domains/${_state.domain}/access/keys`, { label, publicKey });
    if (!res?.success) return toast('error', 'Failed', res?.error || 'Could not add key.');
    document.getElementById('accessAddKeyLabel').value = '';
    document.getElementById('accessAddKeyText').value  = '';
    toast('success', 'Key added', label);
    await _loadAndRender();
  }

  async function generateKey() {
    const label = document.getElementById('accessAddKeyLabel').value.trim()
                  || `generated-${new Date().toISOString().slice(0,10)}`;
    const res = await api.post(`/api/domains/${_state.domain}/access/keys/generate`, { label });
    if (!res?.success) return toast('error', 'Failed', res?.error || 'Could not generate key.');
    _state.pendingKey = { privateKey: res.data.privateKey, fingerprint: res.data.fingerprint };
    document.getElementById('accessGenKeyText').value = res.data.privateKey;
    document.getElementById('accessGenKeyCard').style.display = '';
    document.getElementById('accessGenKeyCard').dataset.domain = _state.domain;
    toast('success', 'Keypair generated', 'Save the private key — it will not be shown again.');
    await _loadAndRender();
  }

  function dismissGenKey() {
    _state.pendingKey = null;
    document.getElementById('accessGenKeyText').value = '';
    document.getElementById('accessGenKeyCard').style.display = 'none';
  }

  function downloadGenKey() {
    const ta = document.getElementById('accessGenKeyText');
    if (!ta.value) return;
    const blob = new Blob([ta.value], { type: 'application/x-pem-file' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = `${_state.domain}_id_ed25519.pem`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function removeKey(fingerprintEncoded) {
    if (!confirm('Remove this key? Any session using it will be disconnected on next auth.')) return;
    const res = await api.del(`/api/domains/${_state.domain}/access/keys/${fingerprintEncoded}`);
    if (!res?.success) return toast('error', 'Failed', res?.error);
    toast('success', 'Key removed', '');
    await _loadAndRender();
  }

  async function toggleFtp(enabled) {
    if (enabled) {
      document.getElementById('accessFtpBox').style.display = '';
      // Enabling requires a password — wait for user to fill it in and hit Reset password.
      const pw = document.getElementById('accessFtpPassword').value;
      if (!pw || pw.length < 8) {
        toast('info', 'Set a password', 'Enter a password (8+ chars) and click Reset password to finalise.');
        return;
      }
      const res = await api.post(`/api/domains/${_state.domain}/access/ftp/enable`, { password: pw });
      if (!res?.success) { document.getElementById('accessFtpToggle').checked = false; return toast('error', 'Failed', res?.error); }
      document.getElementById('accessFtpPassword').value = '';
      toast('success', 'FTP enabled', '');
      await _loadAndRender();
    } else {
      if (!confirm('Disable FTP password access for this domain?')) {
        document.getElementById('accessFtpToggle').checked = true;
        return;
      }
      const res = await api.post(`/api/domains/${_state.domain}/access/ftp/disable`, {});
      if (!res?.success) { document.getElementById('accessFtpToggle').checked = true; return toast('error', 'Failed', res?.error); }
      document.getElementById('accessFtpBox').style.display = 'none';
      toast('success', 'FTP disabled', '');
      await _loadAndRender();
    }
  }

  async function resetFtp() {
    const pw = document.getElementById('accessFtpPassword').value;
    if (!pw || pw.length < 8) return toast('error', 'Validation', 'Password must be at least 8 characters.');
    // If FTP is currently off, enable+set in one shot.
    const currentlyOn = !!_state.data?.account?.ftp_enabled;
    const url  = currentlyOn ? '/access/ftp/reset' : '/access/ftp/enable';
    const res  = await api.post(`/api/domains/${_state.domain}${url}`, { password: pw });
    if (!res?.success) return toast('error', 'Failed', res?.error);
    document.getElementById('accessFtpPassword').value = '';
    document.getElementById('accessFtpToggle').checked = true;
    toast('success', currentlyOn ? 'Password reset' : 'FTP enabled', '');
    await _loadAndRender();
  }

  async function toggleShell(enabled) {
    const res = await api.post(`/api/domains/${_state.domain}/access/shell`, { allowShell: enabled });
    if (!res?.success) {
      document.getElementById('accessShellToggle').checked = !enabled;
      return toast('error', 'Failed', res?.error);
    }
    toast('success', enabled ? 'Shell enabled' : 'Shell disabled', '');
    await _loadAndRender();
  }

  async function togglePlaceholder(enabled) {
    const res = await api.post(`/api/domains/${_state.domain}/access/placeholder`, { enabled });
    if (!res?.success) {
      document.getElementById('accessPlaceholderToggle').checked = !enabled;
      return toast('error', 'Failed', res?.error);
    }
    toast('success', enabled ? 'Placeholder enabled' : 'Placeholder removed', '');
    await _loadAndRender();
  }

  async function retrySsl(host) {
    toast('info', 'Retrying SSL', host);
    const res = await api.post(`/api/domains/${_state.domain}/access/ssl/retry`, { host });
    if (!res?.success) return toast('error', 'Retry failed', res?.error);
    toast('success', 'SSL succeeded', host);
    await _loadAndRender();
  }

  async function removeLegacy(username) {
    if (!confirm(`Remove legacy account "${username}"? Their files will remain at the current ownership.`)) return;
    const res = await api.del(`/api/domains/${_state.domain}/access/legacy/${username}`);
    if (!res?.success) return toast('error', 'Failed', res?.error);
    toast('success', 'Removed', username);
    await _loadAndRender();
  }

  function confirmDeleteUser() {
    const u = _state.data?.account?.username;
    if (!u) return;
    if (!confirm(`Delete deploy user "${u}"?\n\nFiles at the docroot will keep their existing ownership but no one will be able to SSH/SFTP in until you add a new user.\n\nThis cannot be undone.`)) return;
    _deleteUser(u);
  }
  async function _deleteUser(username) {
    // Reuse the legacy /api/ftp DELETE endpoint — same underlying access.deleteAccount.
    const res = await api.del(`/api/ftp/${username}`);
    if (!res?.success) return toast('error', 'Failed', res?.error);
    toast('success', 'Deleted', username);
    close();
  }

  // ── Misc helpers ───────────────────────────────────────────────────────────
  function copyField(id) {
    const el = document.getElementById(id);
    if (!el) return;
    const val = el.textContent || el.value || '';
    navigator.clipboard.writeText(val).then(() => toast('success', 'Copied', '')).catch(() => {});
  }

  function _esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  return {
    open, close, retryAdopt,
    submitKey, generateKey, removeKey,
    downloadGenKey, dismissGenKey,
    toggleFtp, resetFtp, toggleShell, togglePlaceholder,
    retrySsl, removeLegacy, confirmDeleteUser,
    copyField,
  };
})();
