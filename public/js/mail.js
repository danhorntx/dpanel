// ── Mail module ───────────────────────────────────────────────────────────────
window.mail = (() => {
  let currentTab = 'accounts';

  function switchTab(tab, el) {
    currentTab = tab;
    document.querySelectorAll('#section-mail .tabs .tab').forEach(t => t.classList.toggle('active', t === el));
    ['accounts','forwards','dkim','health'].forEach(id => {
      const el = document.getElementById(`tab-mail-${id}`);
      if (el) el.classList.toggle('active', id === tab);
    });
    const addBtn = document.getElementById('mailAddBtn');
    if (addBtn) {
      if (tab === 'accounts') { addBtn.style.display = ''; addBtn.onclick = () => openModal('modalAddAccount'); }
      else if (tab === 'forwards') { addBtn.style.display = ''; addBtn.onclick = () => openModal('modalAddForward'); }
      else { addBtn.style.display = 'none'; }
    }
    if      (tab === 'accounts') loadAccounts();
    else if (tab === 'forwards') loadForwards();
    else if (tab === 'health')   loadHealth();
    else loadDkim();
  }

  async function loadAll() {
    await loadAccounts();
    const addBtn = document.getElementById('mailAddBtn');
    if (addBtn) addBtn.onclick = () => openModal('modalAddAccount');
  }

  // ── Accounts ─────────────────────────────────────────────────────────────────
  async function loadAccounts() {
    const tbody = document.getElementById('accountsTable');
    if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="3"><div class="empty-state"><p>Loading...</p></div></td></tr>`;
    const data = await api.get('/api/mail/accounts');
    if (!data?.success) {
      tbody.innerHTML = `<tr><td colspan="3"><div class="empty-state"><p class="text-red">${data?.error || 'Failed'}</p></div></td></tr>`;
      return;
    }
    if (!data.data.length) {
      tbody.innerHTML = `<tr><td colspan="3"><div class="empty-state"><h4>No mailboxes</h4><p>Create a mail account to get started.</p></div></td></tr>`;
      return;
    }
    tbody.innerHTML = data.data.map(a => `
      <tr>
        <td><span class="font-medium">${a.email}</span></td>
        <td class="td-mono">${a.quota || '—'}</td>
        <td>
          <div class="td-actions" style="justify-content:flex-end">
            <button class="btn btn-ghost btn-xs" onclick="mail.openEditQuota('${a.email}', '${a.quota || '1G'}')">Edit Quota</button>
            <button class="btn btn-ghost btn-xs" onclick="mail.openChangePassword('${a.email}')">Change Password</button>
            <button class="btn btn-danger btn-xs" onclick="mail.confirmDeleteAccount(this, '${a.email}')">Delete</button>
          </div>
        </td>
      </tr>`).join('');
  }

  // ── Forwards ──────────────────────────────────────────────────────────────────
  async function loadForwards() {
    const tbody = document.getElementById('forwardsTable');
    if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="3"><div class="empty-state"><p>Loading...</p></div></td></tr>`;
    const data = await api.get('/api/mail/forwards');
    if (!data?.success) {
      tbody.innerHTML = `<tr><td colspan="3"><div class="empty-state"><p class="text-red">${data?.error || 'Failed'}</p></div></td></tr>`;
      return;
    }
    if (!data.data.length) {
      tbody.innerHTML = `<tr><td colspan="3"><div class="empty-state"><h4>No forwards</h4><p>Add forwarding rules to route mail.</p></div></td></tr>`;
      return;
    }
    tbody.innerHTML = data.data.map(f => `
      <tr>
        <td class="td-mono">${f.source}</td>
        <td class="td-mono text-secondary">
          ${f.destinations}
          ${f.keepsLocal ? '<span class="badge badge-blue" style="margin-left:6px;font-size:.65rem">+ keeps local copy</span>' : ''}
        </td>
        <td>
          <div class="td-actions" style="justify-content:flex-end">
            <button class="btn btn-danger btn-xs" onclick="mail.deleteForward('${f.source}')">Delete</button>
          </div>
        </td>
      </tr>`).join('');
  }

  // ── DKIM ──────────────────────────────────────────────────────────────────────
  async function loadDkim() {
    const wrap = document.getElementById('tab-mail-dkim');
    if (!wrap) return;
    // Load available domains
    const domData = await api.get('/api/domains');
    const domains = domData?.success ? domData.data.map(d => d.domain) : [];
    if (!domains.length) {
      wrap.innerHTML = `<div class="empty-state"><h4>No domains</h4><p>Add a domain first.</p></div>`;
      return;
    }

    wrap.innerHTML = `<div class="table-wrap"><table class="table"><thead><tr>
      <th>Domain</th><th>DKIM</th><th>SPF</th><th>DMARC</th><th style="text-align:right">Actions</th>
    </tr></thead><tbody id="dkimTableBody">
      <tr><td colspan="5"><div class="empty-state"><p>Loading...</p></div></td></tr>
    </tbody></table></div>`;

    const rows = await Promise.all(domains.map(async domain => {
      const [dkimRes, dnsRes] = await Promise.all([
        api.get(`/api/mail/dkim/${domain}`),
        api.get(`/api/mail/dns/${domain}`)
      ]);
      return { domain, dkim: dkimRes?.data, dns: dnsRes?.data };
    }));

    document.getElementById('dkimTableBody').innerHTML = rows.map(r => {
      const dkimOk  = r.dkim?.enabled;
      const spfOk   = r.dns?.verified?.spf?.ok;
      const dmarcOk = r.dns?.verified?.dmarc?.ok;
      const dkimDns = r.dns?.verified?.dkim?.ok;
      return `<tr>
        <td><span class="font-medium">${r.domain}</span></td>
        <td><span class="badge badge-${dkimOk && dkimDns ? 'green' : dkimOk ? 'yellow' : 'red'}">${dkimOk ? (dkimDns ? 'Active' : 'Key ready — DNS needed') : 'Not configured'}</span></td>
        <td><span class="badge badge-${spfOk ? 'green' : 'red'}">${spfOk ? 'OK' : 'Missing'}</span></td>
        <td><span class="badge badge-${dmarcOk ? 'green' : 'red'}">${dmarcOk ? 'OK' : 'Missing'}</span></td>
        <td>
          <div class="td-actions" style="justify-content:flex-end">
            <button class="btn btn-ghost btn-xs" onclick="mail.repairMailZone('${r.domain}', this)" title="Check and auto-fix DNS, DKIM, SSL for this domain">⚙ Check &amp; Repair</button>
            <button class="btn btn-ghost btn-xs" onclick="mail.showDnsRecords('${r.domain}')">DNS Records</button>
            ${dkimOk
              ? `<button class="btn btn-danger btn-xs" onclick="mail.removeDkim('${r.domain}')">Remove DKIM</button>`
              : `<button class="btn btn-primary btn-xs" onclick="mail.generateDkim('${r.domain}')">Generate DKIM</button>`
            }
          </div>
        </td>
      </tr>`;
    }).join('');
  }

  async function generateDkim(domain) {
    toast('info', 'DKIM', `Generating key for ${domain}…`);
    const data = await api.post(`/api/mail/dkim/${domain}`, {});
    if (data?.success) {
      toast('success', 'DKIM key generated', domain);
      showDnsRecords(domain);
      loadDkim();
    } else {
      toast('error', 'Error', data?.error);
    }
  }

  async function removeDkim(domain) {
    const data = await api.del(`/api/mail/dkim/${domain}`);
    if (data?.success) { toast('success', 'DKIM removed', domain); loadDkim(); }
    else toast('error', 'Error', data?.error);
  }

  async function showDnsRecords(domain) {
    const data = await api.get(`/api/mail/dns/${domain}`);
    if (!data?.success) return toast('error', 'Error', data?.error);
    const { records, verified } = data.data;
    const modal = document.getElementById('modalDnsRecords');
    document.getElementById('dnsRecordsDomain').textContent = domain;
    document.getElementById('dnsRecordsList').innerHTML = records.map(r => {
      const key = r.type === 'MX' ? 'mx' : r.name.startsWith('_dmarc') ? 'dmarc' : r.name.includes('_domainkey') ? 'dkim' : 'spf';
      const ok  = verified?.[key]?.ok;
      return `<div class="dns-record-row">
        <div class="dns-record-meta">
          <span class="badge badge-${r.type === 'MX' ? 'blue' : 'purple'}">${r.type}</span>
          <span class="badge badge-${ok ? 'green' : 'red'}">${ok ? '✓ Verified' : '✗ Not set'}</span>
          <span class="text-secondary text-sm">${r.purpose}</span>
        </div>
        <div class="dns-record-name td-mono text-sm">${r.name}</div>
        <div class="dns-record-value td-mono text-sm">${r.priority ? `Priority: ${r.priority} — ` : ''}${r.value}</div>
      </div>`;
    }).join('');
    modal.classList.add('open');
  }

  // ── Account actions ───────────────────────────────────────────────────────────
  async function addAccount() {
    const email    = document.getElementById('addAccountEmail').value.trim();
    const password = document.getElementById('addAccountPassword').value;
    const quota    = document.getElementById('addAccountQuota').value.trim() || '1G';
    if (!email || !password) return toast('error', 'Validation', 'Email and password are required.');
    const btn = document.querySelector('#modalAddAccount .btn-primary');
    btn.classList.add('loading'); btn.disabled = true;
    const data = await api.post('/api/mail/accounts', { email, password, quota });
    btn.classList.remove('loading'); btn.disabled = false;
    if (data?.success) {
      toast('success', 'Account created', email);
      closeModal('modalAddAccount');
      document.getElementById('addAccountEmail').value = '';
      document.getElementById('addAccountPassword').value = '';
      document.getElementById('addAccountQuota').value = '';
      loadAccounts();
    } else toast('error', 'Error', data?.error);
  }

  async function addForward() {
    const source = document.getElementById('addForwardSource').value.trim();
    const dests  = document.getElementById('addForwardDests').value.trim();
    if (!source || !dests) return toast('error', 'Validation', 'Source and destination required.');
    const btn = document.querySelector('#modalAddForward .btn-primary');
    btn.classList.add('loading'); btn.disabled = true;
    const data = await api.post('/api/mail/forwards', { source, destinations: dests });
    btn.classList.remove('loading'); btn.disabled = false;
    if (data?.success) {
      toast('success', 'Forward added', `${source} → ${dests}`);
      closeModal('modalAddForward');
      document.getElementById('addForwardSource').value = '';
      document.getElementById('addForwardDests').value = '';
      loadForwards();
    } else toast('error', 'Error', data?.error);
  }

  function openChangePassword(email) {
    document.getElementById('changePasswordEmail').value = email;
    document.getElementById('changePasswordValue').value = '';
    openModal('modalChangePassword');
  }

  async function changePassword() {
    const email    = document.getElementById('changePasswordEmail').value;
    const password = document.getElementById('changePasswordValue').value;
    if (!password) return toast('error', 'Validation', 'Password is required.');
    const btn = document.querySelector('#modalChangePassword .btn-primary');
    btn.classList.add('loading'); btn.disabled = true;
    const data = await api.put(`/api/mail/accounts/${encodeURIComponent(email)}`, { password });
    btn.classList.remove('loading'); btn.disabled = false;
    if (data?.success) { toast('success', 'Password updated', email); closeModal('modalChangePassword'); }
    else toast('error', 'Error', data?.error);
  }

  function confirmDeleteAccount(btn, email) {
    const existing = btn.parentNode.querySelector('.confirm-prompt');
    if (existing) { deleteAccount(email); return; }
    const prompt = document.createElement('span');
    prompt.className = 'confirm-prompt'; prompt.textContent = 'Click again to confirm';
    btn.parentNode.insertBefore(prompt, btn);
    setTimeout(() => { if (prompt.parentNode) prompt.remove(); }, 3000);
  }

  async function deleteAccount(email) {
    const data = await api.del(`/api/mail/accounts/${encodeURIComponent(email)}`);
    if (data?.success) { toast('success', 'Deleted', email); loadAccounts(); }
    else toast('error', 'Error', data?.error);
  }

  async function deleteForward(source) {
    const data = await api.del(`/api/mail/forwards/${encodeURIComponent(source)}`);
    if (data?.success) { toast('success', 'Forward removed', source); loadForwards(); }
    else toast('error', 'Error', data?.error);
  }


  // ── Password generator ────────────────────────────────────────────────────────
  function generateMailPassword() {
    const upper  = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    const lower  = 'abcdefghjkmnpqrstuvwxyz';
    const digits = '23456789';
    const syms   = '!@#$%^&*-_=+?';
    const all    = upper + lower + digits + syms;
    const arr    = new Uint8Array(16);
    crypto.getRandomValues(arr);
    // Guarantee at least one of each class
    let pw = [
      upper [arr[0]  % upper.length],
      lower [arr[1]  % lower.length],
      digits[arr[2]  % digits.length],
      syms  [arr[3]  % syms.length],
    ];
    for (let i = 4; i < 16; i++) pw.push(all[arr[i] % all.length]);
    // Shuffle
    for (let i = pw.length - 1; i > 0; i--) {
      const j = arr[i % arr.length] % (i + 1);
      [pw[i], pw[j]] = [pw[j], pw[i]];
    }
    const password = pw.join('');
    const input = document.getElementById('addAccountPassword');
    if (!input) return;
    input.type  = 'text';
    input.value = password;
    // Trigger eye-icon reset
    const eyeBtn = input.parentElement.querySelector('button[title]');
    if (eyeBtn) eyeBtn.innerHTML = '&#128064;';
    // Update strength meter
    updatePasswordStrength(password);
    // Select all so user can copy
    input.select();
  }

  function updatePasswordStrength(pw) {
    const wrap  = document.getElementById('addAccountPasswordStrength');
    const bar   = document.getElementById('addAccountPasswordBar');
    const label = document.getElementById('addAccountPasswordLabel');
    if (!wrap) return;
    if (!pw) { wrap.style.display = 'none'; return; }
    wrap.style.display = 'block';

    let score = 0;
    if (pw.length >= 8)  score++;
    if (pw.length >= 12) score++;
    if (/[A-Z]/.test(pw)) score++;
    if (/[0-9]/.test(pw)) score++;
    if (/[^A-Za-z0-9]/.test(pw)) score++;

    const levels = [
      { pct: 20,  color: '#f5654a', text: 'Very weak'  },
      { pct: 40,  color: '#f5a623', text: 'Weak'       },
      { pct: 60,  color: '#f5c842', text: 'Fair'       },
      { pct: 80,  color: '#3ecf8e', text: 'Strong'     },
      { pct: 100, color: '#3ecf8e', text: 'Very strong'},
    ];
    const lvl = levels[Math.min(score - 1, 4)] || levels[0];
    bar.style.width      = lvl.pct + '%';
    bar.style.background = lvl.color;
    label.textContent    = lvl.text;
    label.style.color    = lvl.color;
  }


  // Wire strength meter to password input on DOMContentLoaded
  document.addEventListener('DOMContentLoaded', () => {
    const pwInput = document.getElementById('addAccountPassword');
    if (pwInput) pwInput.addEventListener('input', e => updatePasswordStrength(e.target.value));
  });

  function generateChangePassword() {
    const upper  = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    const lower  = 'abcdefghjkmnpqrstuvwxyz';
    const digits = '23456789';
    const syms   = '!@#$%^&*-_=+?';
    const all    = upper + lower + digits + syms;
    const arr    = new Uint8Array(16);
    crypto.getRandomValues(arr);
    let pw = [
      upper [arr[0]  % upper.length],
      lower [arr[1]  % lower.length],
      digits[arr[2]  % digits.length],
      syms  [arr[3]  % syms.length],
    ];
    for (let i = 4; i < 16; i++) pw.push(all[arr[i] % all.length]);
    for (let i = pw.length - 1; i > 0; i--) {
      const j = arr[i % arr.length] % (i + 1);
      [pw[i], pw[j]] = [pw[j], pw[i]];
    }
    const password = pw.join('');
    const input = document.getElementById('changePasswordValue');
    if (!input) return;
    input.type  = 'text';
    input.value = password;
    // Reset eye icon to "visible" state
    const eyeBtn = input.parentElement.querySelector('button[title="Show/hide password"]');
    if (eyeBtn) eyeBtn.innerHTML = '&#128064;';
    input.select();
  }

  function copyChangePassword() {
    const input = document.getElementById('changePasswordValue');
    if (!input || !input.value) return;
    navigator.clipboard.writeText(input.value).then(() => {
      const btn = document.getElementById('changePasswordCopyBtn');
      if (!btn) return;
      const orig = btn.textContent;
      btn.textContent = 'Copied!';
      btn.disabled = true;
      setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1500);
    });
  }

  // ── Zone repair ───────────────────────────────────────────────────────────────
  async function repairMailZone(domain, btn) {
    const orig = btn.textContent;
    btn.textContent = '⏳ Repairing…';
    btn.disabled = true;
    const data = await api.post(`/api/mail/repair/${domain}`, {});
    btn.textContent = orig;
    btn.disabled = false;
    if (!data) return toast('error', 'Repair', 'No response from server');
    const { fixes = [], issues = [] } = data.data || {};
    if (fixes.length)  toast('success', `Repair: ${domain}`, fixes.join(' · '));
    if (issues.length) toast('error',   `Repair issues`, issues.join(' · '));
    if (!fixes.length && !issues.length) toast('info', `${domain}`, 'Everything looks good — nothing to repair');
    loadDkim();
  }

  // ── Edit quota ────────────────────────────────────────────────────────────────
  function openEditQuota(email, currentQuota) {
    document.getElementById('editQuotaEmail').value   = email;
    document.getElementById('editQuotaValue').value   = currentQuota || '1G';
    document.getElementById('editQuotaLabel').textContent = email;
    openModal('modalEditQuota');
  }

  async function saveQuota() {
    const email = document.getElementById('editQuotaEmail').value;
    const quota = document.getElementById('editQuotaValue').value.trim();
    if (!quota) return toast('error', 'Validation', 'Quota is required');
    const btn = document.querySelector('#modalEditQuota .btn-primary');
    btn.classList.add('loading'); btn.disabled = true;
    const data = await api.put(`/api/mail/accounts/${encodeURIComponent(email)}`, { quota });
    btn.classList.remove('loading'); btn.disabled = false;
    if (data?.success) {
      toast('success', 'Quota updated', `${email} → ${quota}`);
      closeModal('modalEditQuota');
      loadAccounts();
    } else {
      toast('error', 'Error', data?.error);
    }
  }

  function openModal(id) { document.getElementById(id).classList.add('open'); }
  function closeModal(id) { document.getElementById(id).classList.remove('open'); }

  // ── Mail Health ─────────────────────────────────────────────────────────────

  // Human labels + remediation hints. Keyed by check name from lib/mailhealth.js.
  const HEALTH_CHECK_META = {
    'rdns':     { label: 'Reverse DNS (PTR)', hint: 'Set the PTR for your server IP in your hosting provider control panel (Contabo, etc.) to mail.<your-domain>. This is one of the strongest deliverability signals.' },
    'helo':     { label: 'HELO hostname',     hint: 'Postfix\'s HELO must resolve via public DNS to your server IP. Set DPANEL_MAIL_HOSTNAME in /opt/dpanel/.env and re-run configure-mail.sh.' },
    'mail-a':   { label: 'mail.<domain> A',    hint: 'The mail subdomain should resolve to your server IP. Usually auto-created by mail-dns when you provision a domain with mail enabled.' },
    'mx':       { label: 'MX record',          hint: 'MX 10 mail.<domain> — usually auto-created.' },
    'spf':      { label: 'SPF',                hint: 'TXT on apex with v=spf1 authorizing your IP. Auto-published by mail-dns.' },
    'dkim':     { label: 'DKIM',               hint: 'mail._domainkey.<domain> publishes the public key. Run "Repair" on the DKIM tab if missing.' },
    'dmarc':    { label: 'DMARC',              hint: '_dmarc.<domain> publishes the policy. Auto-published with p=quarantine.' },
    'mta-sts':  { label: 'MTA-STS',            hint: 'TLS enforcement policy. DNS + an HTTPS policy file at mta-sts.<domain>. Auto-set during provisioning.' },
    'tls-rpt':  { label: 'TLS-RPT',            hint: '_smtp._tls.<domain> publishes a TLS reporting address. Auto-set during provisioning.' },
    'tls-cert': { label: 'IMAP/SMTP cert',     hint: 'Let\'s Encrypt cert for mail.<domain> served by Dovecot. Run AutoSSL on mail.<domain> if missing.' },
    'rbl':      { label: 'IP reputation (RBL)',hint: 'Your IP is on a Realtime Blocklist. Request delisting at the listing service (links in details) or ask your hosting provider for a different IP.' },
  };

  function _healthIcon(status) {
    switch (status) {
      case 'pass': return { ch: '✓', color: '#4ade80', bg: 'rgba(74,222,128,0.12)' };
      case 'warn': return { ch: '!', color: '#f59e0b', bg: 'rgba(245,158,11,0.12)' };
      case 'fail': return { ch: '✗', color: '#e05c6a', bg: 'rgba(224,92,106,0.12)' };
      case 'skip': return { ch: '–', color: '#7a86a0', bg: 'rgba(255,255,255,0.04)' };
      default:     return { ch: '·', color: '#7a86a0', bg: 'rgba(255,255,255,0.04)' };
    }
  }

  function _escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  // Populate the dropdown with managed DNS zones — those are the domains we
  // can sensibly probe (we serve their DNS, so DKIM/SPF/DMARC checks make sense).
  async function loadHealth() {
    const sel  = document.getElementById('healthDomainSelect');
    const btn  = document.getElementById('healthRunBtn');
    if (!sel) return;
    sel.innerHTML = '<option value="">Loading…</option>';
    btn.disabled = true;

    try {
      const data = await api.get('/api/dns/zones');
      if (!data?.success || !data.data?.length) {
        sel.innerHTML = '<option value="">No managed zones found</option>';
        return;
      }
      const opts = data.data.map(z => `<option value="${_escapeHtml(z.domain)}">${_escapeHtml(z.domain)}</option>`).join('');
      sel.innerHTML = opts;
      btn.disabled = false;
    } catch (err) {
      sel.innerHTML = `<option value="">Error: ${_escapeHtml(err.message)}</option>`;
    }
  }

  async function runHealthProbe() {
    const sel        = document.getElementById('healthDomainSelect');
    const btn        = document.getElementById('healthRunBtn');
    const summary    = document.getElementById('healthSummary');
    const empty      = document.getElementById('healthEmpty');
    const list       = document.getElementById('healthChecksList');
    const domain     = sel.value;
    if (!domain) return;

    empty.style.display = 'none';
    list.innerHTML = `<li style="padding:var(--space-4);text-align:center;color:var(--text-muted)">Probing ${_escapeHtml(domain)}… (this takes about 5–10 seconds)</li>`;
    btn.disabled = true; btn.textContent = 'Probing…';

    try {
      const res = await api.get(`/api/mail/health/${encodeURIComponent(domain)}`);
      if (!res?.success) {
        list.innerHTML = `<li style="padding:var(--space-4);color:var(--text-error)">Error: ${_escapeHtml(res?.error || 'probe failed')}</li>`;
        return;
      }
      _renderHealth(res.data);
    } catch (err) {
      list.innerHTML = `<li style="padding:var(--space-4);color:var(--text-error)">Network error: ${_escapeHtml(err.message)}</li>`;
    } finally {
      btn.disabled = false; btn.textContent = 'Run Probe';
    }
  }

  function _renderHealth(result) {
    const summary  = document.getElementById('healthSummary');
    const list     = document.getElementById('healthChecksList');

    // Summary badge
    const badge = document.getElementById('healthSummaryBadge');
    const sIcon = _healthIcon(result.summary);
    const sLabel = result.summary === 'pass' ? 'All checks healthy'
                 : result.summary === 'warn' ? 'Some warnings'
                 : 'Failing — mail likely not delivering';
    badge.innerHTML = `
      <div style="display:inline-flex;align-items:center;gap:var(--space-3);padding:var(--space-3) var(--space-4);background:${sIcon.bg};border:1px solid ${sIcon.color}40;border-radius:var(--radius-md)">
        <span style="display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;background:${sIcon.color};color:#fff;font-weight:700">${sIcon.ch}</span>
        <div>
          <div style="font-weight:600;font-size:0.9375rem;color:var(--text-primary)">${_escapeHtml(sLabel)}</div>
          <div style="font-size:0.75rem;color:var(--text-muted);margin-top:2px">
            ${result.tally.pass} pass · ${result.tally.warn} warn · ${result.tally.fail} fail · ${result.tally.skip} skipped
          </div>
        </div>
      </div>`;

    document.getElementById('healthServerIp').textContent  = result.server_ip || '—';
    document.getElementById('healthHelo').textContent      = result.helo_hostname || '—';
    document.getElementById('healthCheckedAt').textContent = new Date(result.checked_at).toLocaleString();
    summary.style.display = '';

    // Checks
    list.innerHTML = result.checks.map(c => {
      const meta = HEALTH_CHECK_META[c.name] || { label: c.name, hint: '' };
      const icon = _healthIcon(c.status);
      const showHint = (c.status === 'fail' || c.status === 'warn') && meta.hint;
      return `
        <li style="padding:var(--space-3);background:${icon.bg};border:1px solid var(--border);border-radius:var(--radius-sm)">
          <div style="display:flex;align-items:center;gap:var(--space-3)">
            <span style="display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:${icon.color}1a;color:${icon.color};font-weight:700">${icon.ch}</span>
            <div style="flex:1">
              <div style="font-weight:500;font-size:0.875rem;color:var(--text-primary)">${_escapeHtml(meta.label)}</div>
              <div style="font-size:0.75rem;color:var(--text-muted);margin-top:2px;font-family:var(--font-mono);word-break:break-word">${_escapeHtml(c.detail || '')}</div>
            </div>
            <span style="font-size:0.6875rem;color:${icon.color};text-transform:uppercase;letter-spacing:0.06em;font-weight:600">${c.status}</span>
          </div>
          ${showHint ? `<div style="font-size:0.75rem;color:var(--text-secondary);margin-top:var(--space-2);padding-left:34px;font-style:italic">→ ${_escapeHtml(meta.hint)}</div>` : ''}
        </li>`;
    }).join('');
  }

  return {
    switchTab, loadAll, loadAccounts, loadForwards, loadDkim,
    addAccount, addForward, openChangePassword, changePassword,
    confirmDeleteAccount, deleteAccount, deleteForward,
    generateDkim, removeDkim, showDnsRecords, repairMailZone,
    openEditQuota, saveQuota,
    generateMailPassword, updatePasswordStrength,
    generateChangePassword, copyChangePassword,
    loadHealth, runHealthProbe,
    openModal, closeModal,
  };
})();
