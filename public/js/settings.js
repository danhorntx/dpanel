'use strict';

window.settings = (() => {

  // ── Change Password ────────────────────────────────────────────────────────
  async function changePassword() {
    const currentPw = document.getElementById('settingsCurrentPw').value.trim();
    const newPw     = document.getElementById('settingsNewPw').value.trim();
    const confirmPw = document.getElementById('settingsConfirmPw').value.trim();
    const errEl     = document.getElementById('settingsPwError');
    const saveBtn   = document.getElementById('settingsSaveBtn');

    // Hide previous errors
    errEl.style.display = 'none';
    errEl.textContent   = '';

    // Client-side validation
    if (!currentPw || !newPw || !confirmPw) {
      showError('All three fields are required.');
      return;
    }
    if (newPw.length < 8) {
      showError('New password must be at least 8 characters.');
      return;
    }
    if (newPw !== confirmPw) {
      showError('New passwords do not match.');
      return;
    }

    saveBtn.disabled    = true;
    saveBtn.textContent = 'Updating…';

    try {
      const res  = await fetch('/api/settings/password', {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ currentPassword: currentPw, newPassword: newPw })
      });
      const data = await res.json();

      if (data.success) {
        window.toast('success', 'Password updated', 'You will be redirected to login.');
        setTimeout(() => { window.location.href = '/'; }, 1800);
      } else {
        showError(data.error || 'Could not update password.');
        saveBtn.disabled    = false;
        saveBtn.textContent = 'Update Password';
      }
    } catch (err) {
      showError('Network error — please try again.');
      saveBtn.disabled    = false;
      saveBtn.textContent = 'Update Password';
    }

    function showError(msg) {
      errEl.textContent   = msg;
      errEl.style.display = 'block';
    }
  }

  // ── Admin Email ────────────────────────────────────────────────────────────
  async function saveEmail() {
    const input   = document.getElementById('settingsAdminEmail');
    const errEl   = document.getElementById('settingsEmailError');
    const okEl    = document.getElementById('settingsEmailOk');
    const btn     = document.getElementById('settingsEmailBtn');
    if (!input || !btn) return;

    errEl.style.display = 'none'; errEl.textContent = '';
    okEl.style.display  = 'none';

    const email = input.value.trim();
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const res = await fetch('/api/settings/email', {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email })
      });
      const data = await res.json();
      if (data.success) {
        okEl.style.display = 'inline';
        window.toast && window.toast('success', 'Email saved', email || '(cleared)');
      } else {
        errEl.textContent = data.error || 'Could not save email.';
        errEl.style.display = 'block';
      }
    } catch (_) {
      errEl.textContent = 'Network error — please try again.';
      errEl.style.display = 'block';
    } finally {
      btn.disabled = false; btn.textContent = 'Save Email';
    }
  }

  // ── 2FA (TOTP) ─────────────────────────────────────────────────────────────

  function _show2faSection(which) {
    ['Off', 'Setup', 'On'].forEach(name => {
      const el = document.getElementById('settings2fa' + name);
      if (el) el.style.display = (name.toLowerCase() === which) ? '' : 'none';
    });
  }

  async function loadTwoFaStatus() {
    try {
      const res  = await fetch('/api/settings/2fa/status');
      const data = await res.json();
      if (data?.success) _show2faSection(data.data.enabled ? 'on' : 'off');
    } catch (_) { /* leave default */ }
  }

  async function start2faSetup() {
    const btn = document.getElementById('settings2faEnableBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Generating…'; }
    try {
      const res  = await fetch('/api/settings/2fa/setup', { method: 'POST' });
      const data = await res.json();
      if (!data.success) {
        window.toast && window.toast('error', '2FA setup failed', data.error);
        return;
      }
      document.getElementById('settings2faQr').innerHTML     = data.data.qrSvg;
      document.getElementById('settings2faSecret').textContent = data.data.secret;
      document.getElementById('settings2faCode').value       = '';
      document.getElementById('settings2faError').style.display = 'none';
      _show2faSection('setup');
      setTimeout(() => document.getElementById('settings2faCode').focus(), 50);
    } catch (err) {
      window.toast && window.toast('error', 'Network error', err.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Enable 2FA'; }
    }
  }

  async function verify2faSetup() {
    const codeEl  = document.getElementById('settings2faCode');
    const errEl   = document.getElementById('settings2faError');
    errEl.style.display = 'none';
    const token = (codeEl.value || '').trim();
    if (!/^\d{6}$/.test(token)) {
      errEl.textContent = 'Enter the 6-digit code from your authenticator.';
      errEl.style.display = 'block'; return;
    }
    try {
      const res  = await fetch('/api/settings/2fa/verify', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ token }),
      });
      const data = await res.json();
      if (data.success) {
        window.toast && window.toast('success', '2FA enabled', 'You will need your authenticator on every sign-in.');
        _show2faSection('on');
      } else {
        errEl.textContent = data.error || 'Verification failed';
        errEl.style.display = 'block';
        codeEl.value = ''; codeEl.focus();
      }
    } catch (err) {
      errEl.textContent = 'Network error.'; errEl.style.display = 'block';
    }
  }

  function cancel2faSetup() {
    // Just hide the setup pane — the in-flight secret expires with the session.
    _show2faSection('off');
  }

  async function disable2fa() {
    const pwEl  = document.getElementById('settings2faDisablePw');
    const errEl = document.getElementById('settings2faDisableError');
    errEl.style.display = 'none';
    if (!pwEl.value) {
      errEl.textContent = 'Password required.'; errEl.style.display = 'block'; return;
    }
    try {
      const res  = await fetch('/api/settings/2fa', {
        method:  'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ password: pwEl.value }),
      });
      const data = await res.json();
      if (data.success) {
        window.toast && window.toast('success', '2FA disabled', 'Account is back to password-only.');
        pwEl.value = '';
        _show2faSection('off');
      } else {
        errEl.textContent = data.error || 'Could not disable 2FA';
        errEl.style.display = 'block';
      }
    } catch (err) {
      errEl.textContent = 'Network error.'; errEl.style.display = 'block';
    }
  }

  // ── API Keys ──────────────────────────────────────────────────────────────

  let _newKeyRaw = null;

  function _escapeApiKeyHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  async function loadApiKeys() {
    const list = document.getElementById('settingsApiKeysList');
    if (!list) return;
    list.innerHTML = '<p style="font-size:0.8125rem;color:var(--text-muted)">Loading…</p>';
    try {
      const res  = await fetch('/api/keys');
      const data = await res.json();
      if (!data?.success) {
        list.innerHTML = `<p style="font-size:0.8125rem;color:var(--text-error)">${_escapeApiKeyHtml(data?.error || 'Failed to load')}</p>`;
        return;
      }
      if (!data.data.length) {
        list.innerHTML = '<p style="font-size:0.8125rem;color:var(--text-muted)">No keys yet.</p>';
        return;
      }
      list.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:var(--space-2)">
          ${data.data.map(k => {
            const scopeBadge = k.scope === 'admin'
              ? '<span class="badge badge-amber">admin</span>'
              : '<span class="badge badge-muted">read</span>';
            const lastUsed = k.last_used_at
              ? `last used ${new Date(k.last_used_at).toLocaleString()}${k.last_used_ip ? ' · ' + _escapeApiKeyHtml(k.last_used_ip) : ''}`
              : 'never used';
            return `
              <div style="display:flex;align-items:center;gap:var(--space-3);padding:var(--space-3);background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius-sm)">
                <div style="flex:1;min-width:0">
                  <div style="display:flex;align-items:center;gap:var(--space-2);font-size:0.875rem;font-weight:500;color:var(--text-primary)">
                    ${_escapeApiKeyHtml(k.name)}
                    ${scopeBadge}
                  </div>
                  <div style="font-family:var(--font-mono);font-size:0.75rem;color:var(--text-muted);margin-top:2px">${_escapeApiKeyHtml(k.prefix)}</div>
                  <div style="font-size:0.6875rem;color:var(--text-muted);margin-top:4px">${lastUsed}</div>
                </div>
                <button class="btn btn-danger btn-xs" onclick="window.settings.revokeApiKey(${k.id}, '${_escapeApiKeyHtml(k.name)}')">Revoke</button>
              </div>`;
          }).join('')}
        </div>`;
    } catch (err) {
      list.innerHTML = `<p style="font-size:0.8125rem;color:var(--text-error)">Network error: ${_escapeApiKeyHtml(err.message)}</p>`;
    }
  }

  function openNewApiKey() {
    document.getElementById('newApiKeyName').value  = '';
    document.getElementById('newApiKeyScope').value = 'admin';
    document.getElementById('newApiKeyError').style.display = 'none';
    document.getElementById('modalNewApiKey').classList.add('open');
    setTimeout(() => document.getElementById('newApiKeyName').focus(), 80);
  }

  function closeApiKeyModal() {
    document.getElementById('modalNewApiKey').classList.remove('open');
  }

  async function createApiKey() {
    const name  = document.getElementById('newApiKeyName').value.trim();
    const scope = document.getElementById('newApiKeyScope').value;
    const errEl = document.getElementById('newApiKeyError');
    errEl.style.display = 'none';
    if (!name) { errEl.textContent = 'Name is required.'; errEl.style.display = 'block'; return; }
    const btn = document.getElementById('newApiKeyBtn');
    btn.disabled = true; btn.textContent = 'Creating…';
    try {
      const res  = await fetch('/api/keys', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name, scope }),
      });
      const data = await res.json();
      if (!data.success) {
        errEl.textContent = data.error || 'Could not create key';
        errEl.style.display = 'block';
        btn.disabled = false; btn.textContent = 'Create';
        return;
      }
      // Stash raw key for clipboard + show modal
      _newKeyRaw = data.data.raw;
      document.getElementById('showApiKeyValue').textContent = _newKeyRaw;
      closeApiKeyModal();
      document.getElementById('modalShowApiKey').classList.add('open');
      loadApiKeys();
    } catch (err) {
      errEl.textContent = 'Network error.'; errEl.style.display = 'block';
    } finally {
      btn.disabled = false; btn.textContent = 'Create';
    }
  }

  function copyNewKey() {
    if (!_newKeyRaw) return;
    navigator.clipboard.writeText(_newKeyRaw)
      .then(() => window.toast && window.toast('success', 'Copied', 'Paste into your password manager now.'))
      .catch(() => window.toast && window.toast('error', 'Copy failed', 'Select and copy manually.'));
  }

  function closeShowKey() {
    document.getElementById('modalShowApiKey').classList.remove('open');
    _newKeyRaw = null;
  }

  async function revokeApiKey(id, name) {
    if (!confirm(`Revoke API key "${name}"? Anything using it will stop working immediately.`)) return;
    try {
      const res  = await fetch(`/api/keys/${id}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        window.toast && window.toast('success', 'Key revoked', name);
        loadApiKeys();
      } else {
        window.toast && window.toast('error', 'Revoke failed', data.error);
      }
    } catch (err) {
      window.toast && window.toast('error', 'Network error', err.message);
    }
  }

  // ── Notifications ──────────────────────────────────────────────────────────

  async function loadRecentNotifications() {
    const target = document.getElementById('settingsRecentNotifs');
    if (!target) return;
    try {
      const res  = await fetch('/api/settings/notifications/recent');
      const data = await res.json();
      if (!data?.success) { target.innerHTML = ''; return; }
      if (!data.data.length) {
        target.innerHTML = `<p style="font-size:0.75rem;color:var(--text-muted)">No alerts sent yet.</p>`;
        return;
      }
      target.innerHTML = `
        <div style="font-size:0.75rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:var(--space-2)">Recent</div>
        <div style="display:flex;flex-direction:column;gap:6px">
          ${data.data.slice(0, 10).map(n => {
            const statusColor = n.status === 'sent' ? '#4ade80' : (n.status === 'suppressed' ? '#7a86a0' : '#e05c6a');
            const when = new Date(n.sent_at).toLocaleString();
            return `
              <div style="display:flex;align-items:center;gap:var(--space-2);padding:var(--space-2) var(--space-3);background:var(--bg-elevated);border-radius:var(--radius-sm);border:1px solid var(--border)">
                <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${statusColor};flex-shrink:0"></span>
                <div style="flex:1;min-width:0">
                  <div style="font-size:0.75rem;font-weight:500;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${_escapeApiKeyHtml(n.subject)}">${_escapeApiKeyHtml(n.subject)}</div>
                  <div style="font-size:0.6875rem;color:var(--text-muted)">${when} · ${n.status}${n.error ? ' · ' + _escapeApiKeyHtml(n.error.slice(0,60)) : ''}</div>
                </div>
              </div>`;
          }).join('')}
        </div>`;
    } catch (_) { /* silently skip */ }
  }

  async function sendTestNotification() {
    try {
      const res  = await fetch('/api/settings/notifications/test', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        window.toast && window.toast('success', 'Test sent', 'Check your inbox in a minute.');
      } else {
        window.toast && window.toast('error', 'Test failed', data.data?.reason || data.error);
      }
      loadRecentNotifications();
    } catch (err) {
      window.toast && window.toast('error', 'Network error', err.message);
    }
  }

  // ── Load Server Info ───────────────────────────────────────────────────────
  async function init() {
    // Reset password form
    ['settingsCurrentPw', 'settingsNewPw', 'settingsConfirmPw'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    const errEl   = document.getElementById('settingsPwError');
    const saveBtn = document.getElementById('settingsSaveBtn');
    if (errEl)   { errEl.style.display = 'none'; errEl.textContent = ''; }
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Update Password'; }

    // Load current admin email
    try {
      const res  = await fetch('/api/settings/me');
      const data = await res.json();
      if (data.success) {
        const input = document.getElementById('settingsAdminEmail');
        if (input) input.value = data.data.email || '';
      }
    } catch (_) { /* fall through */ }

    // Load 2FA status
    loadTwoFaStatus();

    // Load API keys
    loadApiKeys();

    // Load recent notifications
    loadRecentNotifications();

    // Fetch server info
    try {
      const res  = await fetch('/api/settings/server-info');
      const data = await res.json();
      if (data.success) {
        const { ip, hostname } = data.data;
        const ipEl       = document.getElementById('settingsServerIp');
        const hostnameEl = document.getElementById('settingsHostname');
        const panelEl    = document.getElementById('settingsPanelUrl');
        if (ipEl)       ipEl.textContent       = ip       || '—';
        if (hostnameEl) hostnameEl.textContent  = hostname || '—';
        if (panelEl)    panelEl.textContent     = `https://${ip}:8080`;
      }
    } catch (_) { /* silently fail — server info is cosmetic */ }
  }

  return {
    changePassword, saveEmail, init,
    start2faSetup, verify2faSetup, cancel2faSetup, disable2fa,
    loadApiKeys, openNewApiKey, closeApiKeyModal, createApiKey,
    copyNewKey, closeShowKey, revokeApiKey,
    sendTestNotification, loadRecentNotifications,
  };
})();
