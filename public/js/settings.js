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

  return { changePassword, init };
})();
