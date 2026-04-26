'use strict';

// ── Access Accounts (FTP/SFTP/SSH) ────────────────────────────────────────────
window.ftp = (() => {
  let currentDomain  = null;
  let currentDocRoot = null;
  let editingUser    = null;

  // ── Open the manage modal for a domain ──────────────────────────────────────
  async function openForDomain(domain, docRoot) {
    currentDomain  = domain;
    currentDocRoot = docRoot;
    document.getElementById('accessModalTitle').textContent = domain;
    await loadAccounts();
    openModal('modalDomainAccess');
  }

  // ── Load & render accounts list ─────────────────────────────────────────────
  async function loadAccounts() {
    const list = document.getElementById('accessAccountsList');
    list.innerHTML = `<div style="text-align:center;padding:var(--space-6);color:var(--text-muted);font-size:0.875rem">Loading…</div>`;
    const data = await api.get(`/api/ftp?domain=${encodeURIComponent(currentDomain)}`);
    if (!data?.success) {
      list.innerHTML = `<div style="color:var(--color-red);padding:var(--space-4);font-size:0.875rem">${data?.error || 'Failed to load accounts'}</div>`;
      return;
    }
    const accounts = data.data;
    if (!accounts.length) {
      list.innerHTML = `<div style="text-align:center;padding:var(--space-6);color:var(--text-muted);font-size:0.875rem">No access accounts yet. Add one below.</div>`;
      return;
    }
    list.innerHTML = accounts.map(a => `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:var(--space-3) var(--space-4);background:var(--bg-elevated);border-radius:var(--radius-md);border:1px solid var(--border);margin-bottom:var(--space-2)">
        <div style="display:flex;align-items:center;gap:var(--space-3)">
          <div style="width:32px;height:32px;border-radius:var(--radius-sm);background:var(--accent-dim);display:flex;align-items:center;justify-content:center;color:var(--accent)">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="5" r="3"/><path d="M2 14c0-3.3 2.7-6 6-6s6 2.7 6 6"/></svg>
          </div>
          <div>
            <div style="font-size:0.875rem;font-weight:500;font-family:var(--font-mono)">${a.username}</div>
            <div style="font-size:0.75rem;color:var(--text-muted);margin-top:2px">
              ${a.allowShell ? 'SFTP + SSH Shell' : 'SFTP only'} ${a.hasSshKey ? '· SSH key set' : ''}
            </div>
          </div>
        </div>
        <div style="display:flex;gap:var(--space-2)">
          <button class="btn btn-ghost btn-xs" onclick="window.ftp.openEdit('${a.username}', ${a.allowShell}, ${a.hasSshKey})">Edit</button>
          <button class="btn btn-danger btn-xs" data-del-user="${a.username}" onclick="window.ftp.confirmDeleteAccount(this, '${a.username}')">Delete</button>
        </div>
      </div>`).join('');
  }

  // ── Open Add Account modal ───────────────────────────────────────────────────
  function openAdd() {
    // Reset form
    ['addAccessUsername','addAccessPassword','addAccessConfirm','addAccessSshKey'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    const shellEl = document.getElementById('addAccessAllowShell');
    if (shellEl) shellEl.checked = false;
    const errEl = document.getElementById('addAccessError');
    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
    openModal('modalAddAccess');
  }

  // ── Submit add form ──────────────────────────────────────────────────────────
  async function submitAdd() {
    const username   = document.getElementById('addAccessUsername').value.trim();
    const password   = document.getElementById('addAccessPassword').value;
    const confirm    = document.getElementById('addAccessConfirm').value;
    const allowShell = document.getElementById('addAccessAllowShell').checked;
    const sshKey     = document.getElementById('addAccessSshKey').value.trim();
    const errEl      = document.getElementById('addAccessError');
    const btn        = document.getElementById('addAccessBtn');

    errEl.style.display = 'none';

    if (!username)          return showErr(errEl, 'Username is required.');
    if (password.length < 8) return showErr(errEl, 'Password must be at least 8 characters.');
    if (password !== confirm) return showErr(errEl, 'Passwords do not match.');

    btn.disabled = true; btn.textContent = 'Creating…';

    const data = await api.post('/api/ftp', {
      domain: currentDomain, docRoot: currentDocRoot,
      username, password, allowShell, sshKey: sshKey || null
    });

    btn.disabled = false; btn.textContent = 'Create Account';

    if (data?.success) {
      window.toast('success', 'Account created', `${username} can now connect via SFTP${allowShell ? ' and SSH' : ''}.`);
      closeModal('modalAddAccess');
      loadAccounts();
    } else {
      showErr(errEl, data?.error || 'Failed to create account.');
    }
  }

  // ── Open Edit modal ──────────────────────────────────────────────────────────
  function openEdit(username, allowShell, hasSshKey) {
    editingUser = username;
    document.getElementById('editAccessUsername').textContent = username;
    document.getElementById('editAccessPassword').value  = '';
    document.getElementById('editAccessConfirm').value   = '';
    document.getElementById('editAccessSshKey').value    = '';
    document.getElementById('editAccessShellBadge').textContent = allowShell ? 'SFTP + SSH Shell' : 'SFTP only';
    document.getElementById('editAccessSshKeyHint').textContent = hasSshKey ? 'A key is set. Paste a new key to replace it, or leave blank to keep existing.' : 'No key set. Paste a public key to add one.';
    const errEl = document.getElementById('editAccessError');
    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
    // Reset copy button state
    const copyBtn = document.getElementById('editPwCopyBtn');
    if (copyBtn) { copyBtn.style.display = 'none'; copyBtn._pw = null; }
    openModal('modalEditAccess');
  }

  // ── Save password from edit modal ────────────────────────────────────────────
  async function savePassword() {
    const password = document.getElementById('editAccessPassword').value;
    const confirm  = document.getElementById('editAccessConfirm').value;
    const errEl    = document.getElementById('editAccessError');
    errEl.style.display = 'none';

    if (!password)              return showErr(errEl, 'Enter a new password.');
    if (password.length < 8)   return showErr(errEl, 'Password must be at least 8 characters.');
    if (password !== confirm)  return showErr(errEl, 'Passwords do not match.');

    const btn = document.getElementById('editSavePwBtn');
    btn.disabled = true; btn.textContent = 'Saving…';
    const data = await api.put(`/api/ftp/${editingUser}/password`, { password });
    btn.disabled = false; btn.textContent = 'Update Password';

    if (data?.success) {
      window.toast('success', 'Password updated', editingUser);
      document.getElementById('editAccessPassword').value = '';
      document.getElementById('editAccessConfirm').value  = '';
    } else {
      showErr(errEl, data?.error || 'Failed to update password.');
    }
  }

  // ── Save SSH key from edit modal ─────────────────────────────────────────────
  async function saveSshKey() {
    const sshKey = document.getElementById('editAccessSshKey').value.trim();
    const errEl  = document.getElementById('editAccessError');
    errEl.style.display = 'none';

    const btn = document.getElementById('editSaveKeyBtn');
    btn.disabled = true; btn.textContent = 'Saving…';
    const data = await api.put(`/api/ftp/${editingUser}/sshkey`, { sshKey: sshKey || null });
    btn.disabled = false; btn.textContent = 'Save SSH Key';

    if (data?.success) {
      window.toast('success', sshKey ? 'SSH key updated' : 'SSH key removed', editingUser);
      closeModal('modalEditAccess');
      loadAccounts();
    } else {
      showErr(errEl, data?.error || 'Failed to save SSH key.');
    }
  }

  // ── Delete account ───────────────────────────────────────────────────────────
  function confirmDeleteAccount(btn, username) {
    const existing = btn.parentNode.querySelector('.confirm-prompt');
    if (existing) { deleteAccount(username); return; }
    const prompt = document.createElement('span');
    prompt.className = 'confirm-prompt';
    prompt.textContent = 'Click again to confirm';
    btn.parentNode.insertBefore(prompt, btn);
    setTimeout(() => { if (prompt.parentNode) prompt.remove(); }, 3000);
  }

  async function deleteAccount(username) {
    const data = await api.del(`/api/ftp/${username}`);
    if (data?.success) {
      window.toast('success', 'Account deleted', username);
      loadAccounts();
    } else {
      window.toast('error', 'Error', data?.error);
    }
  }

  // ── Password generator (shared) ──────────────────────────────────────────────
  function _makePw() {
    const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%^&*';
    const arr   = new Uint8Array(20);
    crypto.getRandomValues(arr);
    return Array.from(arr).map(b => chars[b % chars.length]).join('');
  }

  // For the Add Account modal
  function generatePassword() {
    const pw    = _makePw();
    const pwEl  = document.getElementById('addAccessPassword');
    const cfmEl = document.getElementById('addAccessConfirm');
    if (pwEl)  { pwEl.value  = pw; pwEl.type  = 'text'; setTimeout(() => { pwEl.type  = 'password'; }, 3000); }
    if (cfmEl) { cfmEl.value = pw; cfmEl.type = 'text'; setTimeout(() => { cfmEl.type = 'password'; }, 3000); }
    window.toast('success', 'Password generated', 'Visible for 3 seconds — copy it now.');
  }

  // For the Edit Account modal
  function generateEditPassword() {
    const pw    = _makePw();
    const pwEl  = document.getElementById('editAccessPassword');
    const cfmEl = document.getElementById('editAccessConfirm');
    if (pwEl)  { pwEl.value  = pw; pwEl.type  = 'text'; setTimeout(() => { pwEl.type  = 'password'; }, 3000); }
    if (cfmEl) { cfmEl.value = pw; cfmEl.type = 'text'; setTimeout(() => { cfmEl.type = 'password'; }, 3000); }
    // Show copy button
    const copyBtn = document.getElementById('editPwCopyBtn');
    if (copyBtn) { copyBtn.style.display = ''; copyBtn._pw = pw; }
    window.toast('success', 'Password generated', 'Visible for 3 seconds — copy it now.');
  }

  function copyEditPassword() {
    const copyBtn = document.getElementById('editPwCopyBtn');
    const pw = copyBtn?._pw || document.getElementById('editAccessPassword')?.value || '';
    if (!pw) return;
    navigator.clipboard.writeText(pw)
      .then(() => window.toast('success', 'Copied', 'Password copied to clipboard.'))
      .catch(() => window.toast('error', 'Copy failed', 'Select and copy the field manually.'));
  }

  // ── SSH keypair generator ────────────────────────────────────────────────────
  async function generateKeypair() {
    const btn = document.getElementById('genKeyBtn');
    btn.disabled = true; btn.textContent = 'Generating…';
    try {
      const data = await api.post('/api/ftp/generate-keypair', {});
      btn.disabled = false; btn.textContent = 'Generate Key Pair';
      if (!data?.success) return window.toast('error', 'Key generation failed', data?.error);

      // Populate public key in form
      const pubEl = document.getElementById('addAccessSshKey');
      if (pubEl) pubEl.value = data.publicKey;

      // Offer private key as download
      downloadText(data.privateKey, 'dpanel_id_ed25519');
      window.toast('success', 'Key pair generated', 'Private key downloaded — keep it safe. Public key filled in below.');
    } catch(e) {
      btn.disabled = false; btn.textContent = 'Generate Key Pair';
      window.toast('error', 'Error', e.message);
    }
  }

  function downloadText(text, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ── Utils ────────────────────────────────────────────────────────────────────
  function showErr(el, msg) {
    el.textContent   = msg;
    el.style.display = 'block';
  }
  function openModal(id)  { document.getElementById(id).classList.add('open'); }
  function closeModal(id) { document.getElementById(id).classList.remove('open'); }

  return { openForDomain, openAdd, submitAdd, openEdit, savePassword, saveSshKey, confirmDeleteAccount, closeModal, generatePassword, generateEditPassword, copyEditPassword, generateKeypair };
})();
