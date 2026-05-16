// ── Domains module ────────────────────────────────────────────────────────────
window.domains = (() => {
  let currentDomain  = null;
  let pendingDelete  = null;
  let _certMap       = {};   // domain → { daysLeft, expiry }

  // ── SSL cert badge helper ─────────────────────────────────────────────────
  function sslBadge(v) {
    if (!v.ssl) return '<span class="badge badge-muted">None</span>';
    const cert = _certMap[v.domain];
    if (!cert) return '<span class="badge badge-green"><span class="badge-dot"></span>Active</span>';
    const d = cert.daysLeft;
    if (d === null || d === undefined) return '<span class="badge badge-green"><span class="badge-dot"></span>Active</span>';
    if (d < 14) return `<span class="badge badge-red" title="Expires in ${d} day${d===1?'':'s'}"><span class="badge-dot"></span>${d}d left</span>`;
    if (d < 30) return `<span class="badge badge-amber" title="Expires in ${d} days"><span class="badge-dot"></span>${d}d left</span>`;
    return `<span class="badge badge-green" title="Expires in ${d} days"><span class="badge-dot"></span>Active</span>`;
  }

  async function load() {
    const tbody = document.getElementById('domainsTable');
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><p>Loading...</p></div></td></tr>`;

    // Fetch domains + certs in parallel
    const [data, certData] = await Promise.all([
      api.get('/api/domains'),
      api.get('/api/ssl').catch(() => null),
    ]);

    // Build cert lookup map
    _certMap = {};
    if (certData?.success) {
      for (const c of certData.data) {
        // LE certs directory name may be "domain.com-0001" etc — normalise
        const key = c.domain.replace(/-\d+$/, '');
        _certMap[key] = c;
      }
    }

    if (!data || !data.success) {
      tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><p class="text-red">${data?.error || 'Failed to load'}</p></div></td></tr>`;
      return;
    }
    const vhosts = data.data;
    const countEl = document.getElementById('domainCount');
    if (countEl) countEl.textContent = vhosts.length;

    if (!vhosts.length) {
      tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state">
        <div class="empty-state-icon"><svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6.5"/><path d="M8 1.5C8 1.5 6 4 6 8s2 6.5 2 6.5M8 1.5C8 1.5 10 4 10 8s-2 6.5-2 6.5M1.5 8h13"/></svg></div>
        <h4>No domains yet</h4><p>Add your first domain to get started.</p>
      </div></td></tr>`;
      return;
    }

    tbody.innerHTML = vhosts.map(v => `
      <tr>
        <td class="td-truncate" title="${v.domain}"><span class="font-medium">${v.domain}</span></td>
        <td class="td-mono td-truncate" title="${v.docRoot}">${v.docRoot}</td>
        <td>${sslBadge(v)}</td>
        <td id="disk-${v.domain.replace(/\./g, '-')}" class="text-secondary text-sm">
          <span class="text-muted">—</span>
        </td>
        <td>${v.enabled ? '<span class="badge badge-green"><span class="badge-dot"></span>Enabled</span>' : '<span class="badge badge-red">Disabled</span>'}</td>
        <td>
          <div class="td-actions">
            <button class="btn btn-ghost btn-xs" onclick="window.domains.openHealth('${v.domain}')">Health</button>
            ${v.enabled
              ? `<button class="btn btn-ghost btn-xs" onclick="window.domains.toggle('${v.domain}', false)">Disable</button>`
              : `<button class="btn btn-ghost btn-xs" onclick="window.domains.toggle('${v.domain}', true)">Enable</button>`}
            <details class="row-menu">
              <summary aria-label="More actions">⋯</summary>
              <div class="row-menu-list">
                <button onclick="window.ftp.openForDomain('${v.domain}', '${v.docRoot}')">SFTP Access</button>
                <button onclick="window.domains.openLogs('${v.domain}')">Logs</button>
                <button onclick="window.domains.openRedirects('${v.domain}')">Redirects</button>
                <button onclick="window.domains.openConfig('${v.domain}')">Apache Config</button>
                <div class="menu-sep"></div>
                <button class="danger" onclick="window.domains.confirmDelete('${v.domain}')">Delete</button>
              </div>
            </details>
          </div>
        </td>
      </tr>`).join('');

    // Lazy-load disk usage in background (non-blocking)
    loadDiskUsage(vhosts);
  }

  // ── Lazy disk usage loader ────────────────────────────────────────────────
  async function loadDiskUsage(vhosts) {
    for (const v of vhosts) {
      const cellId = `disk-${v.domain.replace(/\./g, '-')}`;
      const cell = document.getElementById(cellId);
      if (!cell) continue;
      try {
        const d = await api.get(`/api/domains/${v.domain}/diskusage`);
        if (d?.success) cell.textContent = d.data.size;
      } catch (_) {}
      // Small delay between requests to avoid hammering the server
      await new Promise(r => setTimeout(r, 80));
    }
  }

  // ── Domain error log viewer ───────────────────────────────────────────────
  async function openLogs(domain) {
    const modal = document.getElementById('modalDomainLogs');
    if (!modal) return;
    document.getElementById('logsModalDomain').textContent = domain;
    document.getElementById('logsModalContent').textContent = 'Loading…';
    document.getElementById('logsModalTab').dataset.current = 'error';
    _setLogsTab(modal, 'error');
    openModal('modalDomainLogs');
    await fetchLogs(domain, 'error');
  }

  async function fetchLogs(domain, type) {
    const content = document.getElementById('logsModalContent');
    content.textContent = 'Loading…';
    const endpoint = type === 'access'
      ? `/api/logs/domain/${domain}/access`
      : `/api/logs/domain/${domain}`;
    const data = await api.get(endpoint);
    if (!data?.success) {
      content.textContent = `Error: ${data?.error}`;
      return;
    }
    if (!data.data.length) {
      content.textContent = data.note || 'No log entries found.';
      return;
    }
    content.textContent = data.data.join('\n');
    // Scroll to bottom
    content.parentElement.scrollTop = content.parentElement.scrollHeight;
  }

  function _setLogsTab(modal, type) {
    modal.querySelectorAll('.logs-tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.logType === type);
    });
  }

  function switchLogsTab(type) {
    const modal = document.getElementById('modalDomainLogs');
    if (!modal) return;
    _setLogsTab(modal, type);
    const domain = document.getElementById('logsModalDomain').textContent;
    fetchLogs(domain, type);
  }

  // ── Add Domain: pending generated keypair (kept in memory for the
  //    Setup Complete modal so we can offer the private key download once) ──
  let _pendingGeneratedKey = null;   // { privateKey, publicKey, fingerprint }

  async function generateAddKeypair() {
    const btn = document.getElementById('addDomainGenBtn');
    if (!btn) return;
    btn.disabled = true; const original = btn.textContent; btn.textContent = 'Generating…';
    try {
      // Re-uses the existing legacy /api/ftp/generate-keypair which generates
      // an ed25519 keypair in tmpfs and returns it — saves a route round-trip.
      const data = await api.post('/api/ftp/generate-keypair', {});
      if (!data?.success) throw new Error(data?.error || 'Generation failed');
      _pendingGeneratedKey = {
        privateKey:  data.privateKey,
        publicKey:   data.publicKey,
        fingerprint: '(computed server-side on submit)',
      };
      const ta = document.getElementById('addDomainPublicKey');
      ta.value = data.publicKey;
      toast('success', 'Keypair generated', 'Private key will be shown after the domain is created.');
    } catch (err) {
      toast('error', 'Failed', err.message);
    } finally {
      btn.disabled = false; btn.textContent = original;
    }
  }

  function add() {
    const name       = document.getElementById('addDomainName').value.trim();
    const root       = document.getElementById('addDomainRoot')?.value.trim() || '';
    const mailDns    = document.getElementById('addDomainMailDns')?.checked || false;
    const publicKey  = document.getElementById('addDomainPublicKey')?.value.trim() || '';
    const keyLabel   = document.getElementById('addDomainKeyLabel')?.value.trim() || 'primary';
    const allowShell = document.getElementById('addDomainAllowShell')?.checked || false;
    const allowFtp   = document.getElementById('addDomainAllowFtp')?.checked || false;
    const ftpPw      = document.getElementById('addDomainFtpPassword')?.value || '';
    const placeholder = document.getElementById('addDomainPlaceholder')?.checked || false;

    if (!name) return toast('error', 'Validation', 'Domain name is required.');
    if (!publicKey && !allowFtp) {
      return toast('error', 'Validation', 'Paste a public key or enable FTP password access.');
    }
    if (allowFtp && ftpPw.length < 8) {
      return toast('error', 'Validation', 'FTP password must be at least 8 characters.');
    }

    const sshKeys = publicKey ? [{
      label:     keyLabel,
      publicKey: publicKey,
      source:    _pendingGeneratedKey && _pendingGeneratedKey.publicKey === publicKey ? 'generated' : 'pasted',
    }] : [];

    _doAdd({
      domain:       name,
      docRoot:      root || undefined,
      setupMailDns: mailDns,
      sshKeys,
      allowShell,
      allowFtp,
      password:     allowFtp ? ftpPw : undefined,
      placeholder,
    });
  }

  async function _doAdd(payload) {
    const btn = document.querySelector('#modalAddDomain .btn-primary');
    btn.classList.add('loading'); btn.disabled = true;
    btn.textContent = 'Creating domain…';

    const sslMsg = setTimeout(() => {
      if (btn.disabled) btn.textContent = 'Requesting SSL…';
    }, 4000);

    const data = await api.post('/api/domains', payload);
    clearTimeout(sslMsg);
    btn.classList.remove('loading'); btn.disabled = false;
    btn.textContent = 'Create Domain';

    if (data) {
      // Attach the pre-generated private key (if any) to the response so the
      // Setup Complete modal can display + offer it for download exactly once.
      if (data.success && _pendingGeneratedKey && payload.sshKeys?.[0]?.publicKey === _pendingGeneratedKey.publicKey) {
        data.credentials = data.credentials || {};
        data.credentials.generatedPrivateKey = _pendingGeneratedKey.privateKey;
      }

      closeModal('modalAddDomain');
      _resetAddDomainForm();
      load();
      showResult(payload.domain, data);
      _pendingGeneratedKey = null;
    } else {
      toast('error', 'Failed', 'Network error');
    }
  }

  function _resetAddDomainForm() {
    const ids = ['addDomainName', 'addDomainRoot', 'addDomainPublicKey',
                 'addDomainKeyLabel', 'addDomainFtpPassword'];
    ids.forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    ['addDomainMailDns', 'addDomainAllowShell', 'addDomainAllowFtp', 'addDomainPlaceholder']
      .forEach(id => { const el = document.getElementById(id); if (el) el.checked = false; });
    const ftpBox = document.getElementById('addDomainFtpPwBox');
    if (ftpBox) ftpBox.style.display = 'none';
  }

  // ── Human labels for reconciler step names ────────────────────────────────
  const STEP_LABELS = {
    'apache-vhost':     'Apache vhost',
    'sftp-account':     'SFTP deploy account',
    'dns':              'DNS',
    'mail-dns':         'Mail DNS (MX / SPF / DMARC / DKIM)',
    'mail-account':     'First mailbox',
    'mail-autoconfig':  'Mail autoconfig (Outlook / Apple Mail / TB)',
    'webmail-vhost':    'Webmail proxy vhost',
    'ssl-main':         'SSL — main domain',
    'ssl-webmail':      'SSL — webmail',
    'ssl-mail':         'SSL — mail server (IMAP/SMTP)',
    'dovecot-sni':      'Dovecot per-domain TLS',
    // Destroy-side step names
    'autoconfig-vhost': 'Autoconfig vhost teardown',
    'ssl-certs':        'SSL certs teardown',
    'dkim':             'DKIM keys teardown',
  };

  function _stepIcon(status) {
    switch (status) {
      case 'success': return { icon: '✓', color: 'var(--text-success, #4ade80)', bg: 'rgba(74,222,128,0.12)' };
      case 'skipped': return { icon: '–', color: 'var(--text-muted)',           bg: 'rgba(255,255,255,0.04)' };
      case 'warning': return { icon: '!', color: 'var(--accent-amber, #f59e0b)', bg: 'rgba(245,158,11,0.12)' };
      case 'failed':  return { icon: '✗', color: 'var(--text-error, #e05c6a)',  bg: 'rgba(224,92,106,0.12)' };
      default:        return { icon: '·', color: 'var(--text-muted)',           bg: 'rgba(255,255,255,0.04)' };
    }
  }

  function _fmtDuration(ms) {
    if (ms == null) return '';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }

  // Treat ssl-webmail's "non-fatal SSL failed" detail string as a warning, not
  // a plain success. (Backend reports status:success with a warning in detail —
  // see lib/state/domain.js. This bit of glue is documented in the source.)
  function _normalizeStatus(step) {
    if (step.status === 'success' && step.detail && /failed/i.test(step.detail)) return 'warning';
    return step.status;
  }

  function _renderSteps(steps, rolledBack) {
    const ul = document.getElementById('credStepsList');
    ul.innerHTML = '';
    const rolledSet = new Set(rolledBack || []);
    for (const step of steps || []) {
      const status = _normalizeStatus(step);
      const { icon, color, bg } = _stepIcon(status);
      const label = STEP_LABELS[step.name] || step.name;
      const dur = _fmtDuration(step.duration_ms);
      const wasRolledBack = rolledSet.has(step.name);

      const detailHtml = step.error
        ? `<div style="font-size:0.75rem;color:var(--text-error,#e05c6a);margin-top:4px;font-family:var(--font-mono);white-space:pre-wrap;word-break:break-word">${escapeHtml(step.error)}</div>`
        : (step.detail
            ? `<div style="font-size:0.75rem;color:var(--text-muted);margin-top:2px">${escapeHtml(step.detail)}</div>`
            : '');

      const rolledHtml = wasRolledBack
        ? `<span class="badge badge-muted" style="margin-left:6px;font-size:0.625rem">rolled back</span>`
        : '';

      const li = document.createElement('li');
      li.style = `display:flex;flex-direction:column;padding:var(--space-2) var(--space-3);background:${bg};border-radius:var(--radius-sm);border:1px solid var(--border-subtle, rgba(255,255,255,0.05))`;
      li.innerHTML = `
        <div style="display:flex;align-items:center;gap:var(--space-2)">
          <span style="display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;background:${color}1a;color:${color};font-weight:700;font-size:0.75rem">${icon}</span>
          <span style="flex:1;font-size:0.8125rem;color:var(--text-primary)">${escapeHtml(label)}${rolledHtml}</span>
          <span style="font-size:0.75rem;color:var(--text-muted);font-variant-numeric:tabular-nums">${status === 'skipped' ? 'skipped' : dur}</span>
        </div>
        ${detailHtml}
      `;
      ul.appendChild(li);
    }
    document.getElementById('credSteps').style.display = steps?.length ? '' : 'none';
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  /**
   * Render the unified create-result modal for both success and failure paths.
   *
   * Success → green header, steps timeline, SSL/mail badges, SFTP credentials.
   * Failure → red header, top-level error banner, steps timeline (with rolled-back
   *            marks), no credentials, no SFTP section.
   */
  function showResult(domain, data) {
    const header   = document.getElementById('credHeader');
    const topError = document.getElementById('credTopError');
    const sslEl    = document.getElementById('credSSLStatus');
    const mailDnsEl = document.getElementById('credMailDnsStatus');
    const credsSection = document.getElementById('credsSFTPSection');
    const acctErrEl = document.getElementById('credAccountError');

    document.getElementById('credDomain').textContent = domain || '—';

    // Header + top-level error
    if (data.success) {
      header.textContent = 'Domain Setup Complete';
      header.style.color = '';
      topError.style.display = 'none';
    } else {
      header.textContent = 'Domain Setup Failed';
      header.style.color = 'var(--text-error, #e05c6a)';
      topError.textContent = data.error || 'Unknown error';
      topError.style.display = '';
    }

    // Steps timeline (always shown when we have them)
    _renderSteps(data.steps || [], data.rolledBack || []);

    // From here down, the existing summary widgets only apply on success.
    if (!data.success) {
      sslEl.innerHTML = '';
      mailDnsEl.style.display = 'none';
      credsSection.style.display = 'none';
      acctErrEl.style.display = 'none';
      openModal('modalSetupComplete');
      return;
    }

    const c = data.credentials || {};

    // SSL summary
    if (c.sslStatus === 'active') {
      sslEl.innerHTML = '<span class="badge badge-green"><span class="badge-dot"></span>SSL Active — HTTPS ready</span>';
    } else if (c.sslStatus === 'failed') {
      sslEl.innerHTML = `<span class="badge badge-red">SSL Failed</span>
        <p style="font-size:0.75rem;color:var(--text-secondary);margin-top:4px">Retry from <strong>SSL Certs → AutoSSL</strong> once DNS fully propagates.</p>`;
    } else {
      sslEl.innerHTML = '<span class="badge badge-muted">SSL Pending</span>';
    }

    // Mail DNS summary
    if (c.mailDns) {
      mailDnsEl.style.display = '';
      if (c.mailDns.applied) {
        const dkim = c.mailDns.dkimGenerated ? ' (DKIM key generated)' : '';
        mailDnsEl.innerHTML = `<span class="badge badge-green"><span class="badge-dot"></span>Mail DNS configured${dkim}</span>`;
      } else {
        mailDnsEl.innerHTML = `<span class="badge badge-amber">Mail DNS pending</span>
          <p style="font-size:0.75rem;color:var(--text-muted);margin-top:6px">No managed parent zone — configure manually once DNS propagates, or retry under <strong style="color:var(--text-secondary)">Mail → DNS Setup</strong>.</p>`;
      }
    } else {
      mailDnsEl.style.display = 'none';
    }

    // ── SSH-first: generated private key (one-time display) ───────────────
    const privSection = document.getElementById('credPrivateKeySection');
    if (privSection) {
      if (c.generatedPrivateKey) {
        document.getElementById('credPrivateKey').value      = c.generatedPrivateKey;
        document.getElementById('credKeyFingerprint').textContent =
          c.keys?.[0]?.fingerprint ? `Fingerprint: ${c.keys[0].fingerprint}` : '';
        privSection.style.display = '';
        privSection.dataset.domain = domain;
      } else {
        privSection.style.display = 'none';
      }
    }

    // ── SSH-first: registered key fingerprints ────────────────────────────
    const keysSection = document.getElementById('credKeysSection');
    if (keysSection) {
      if (c.keys && c.keys.length) {
        const list = document.getElementById('credKeysList');
        list.innerHTML = c.keys.map(k =>
          `<li style="padding:6px 10px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius-sm)">
             <span style="color:var(--accent)">${k.label || 'key'}</span>
             <span style="color:var(--text-muted)">·</span>
             <span>${k.keyType}</span>
             <span style="color:var(--text-muted)"> ${k.fingerprint || ''}</span>
           </li>`
        ).join('');
        keysSection.style.display = '';
      } else {
        keysSection.style.display = 'none';
      }
    }

    // ── Connection details ────────────────────────────────────────────────
    acctErrEl.style.display = 'none';
    if (c.username) {
      document.getElementById('credHost').textContent     = c.host || '—';
      document.getElementById('credPort').textContent     = c.port || 22;
      document.getElementById('credUsername').textContent = c.username;
      // Password row: hidden in SSH-only mode (c.password === null), shown
      // when FTP fallback was requested.
      const pwRow = document.getElementById('credPassword')?.closest('div[style*="background:var(--bg-elevated)"]');
      if (c.password) {
        document.getElementById('credPassword').textContent = c.password;
        if (pwRow) pwRow.style.display = '';
      } else {
        if (pwRow) pwRow.style.display = 'none';
      }
      document.getElementById('credDocRoot').textContent  = c.docRoot || '—';
      credsSection.style.display = '';
    } else {
      credsSection.style.display = 'none';
      if (c.accountError) {
        acctErrEl.textContent = 'SFTP account error: ' + c.accountError;
        acctErrEl.style.display = '';
      }
    }

    openModal('modalSetupComplete');
  }

  // Back-compat shim: any older callers expecting showCredentials() get the
  // new modal too. The legacy callsite in this file no longer invokes it.
  function showCredentials(c) {
    showResult(c?.domain || '', { success: true, credentials: c, steps: [] });
  }

  function copyCredField(id) {
    const el = document.getElementById(id);
    if (!el) return;
    const val = el.value || el.textContent || '';
    navigator.clipboard.writeText(val)
      .then(() => toast('success', 'Copied', ''))
      .catch(() => {});
  }

  // Download the one-time generated private key as a .pem file. After the
  // user closes the Setup Complete modal the key is gone — DPanel never
  // persists private keys.
  function downloadPrivateKey() {
    const ta = document.getElementById('credPrivateKey');
    if (!ta?.value) return toast('error', 'No key', 'Private key already cleared.');
    const domain = document.getElementById('credPrivateKeySection').dataset.domain || 'dpanel';
    const blob   = new Blob([ta.value], { type: 'application/x-pem-file' });
    const url    = URL.createObjectURL(blob);
    const a      = document.createElement('a');
    a.href = url;
    a.download = `${domain}_id_ed25519.pem`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function toggle(domain, enable) {
    const url = enable ? `/api/domains/${domain}/enable` : `/api/domains/${domain}/disable`;
    const data = await api.post(url, {});
    if (data?.success) {
      toast('success', enable ? 'Enabled' : 'Disabled', domain);
      load();
    } else {
      toast('error', 'Error', data?.error);
    }
  }

  function confirmDelete(domain) {
    pendingDelete = domain;
    document.getElementById('deleteDomainDisplay').textContent = domain;
    document.getElementById('deleteDomainLabel').textContent   = domain;
    document.getElementById('deleteDomainInput').value         = '';
    const btn = document.getElementById('deleteDomainConfirmBtn');
    btn.disabled = true;
    btn.style.opacity = '0.4';
    openModal('modalDeleteDomain');
    setTimeout(() => document.getElementById('deleteDomainInput').focus(), 120);
  }

  function checkDeleteInput() {
    const val = document.getElementById('deleteDomainInput').value.trim();
    const btn = document.getElementById('deleteDomainConfirmBtn');
    const match = (val === pendingDelete);
    btn.disabled      = !match;
    btn.style.opacity = match ? '1' : '0.4';
  }

  async function submitDelete() {
    if (!pendingDelete) return;
    const data = await api.del(`/api/domains/${pendingDelete}`);
    if (data?.success) {
      toast('success', 'Deleted', pendingDelete);
      closeModal('modalDeleteDomain');
      pendingDelete = null;
      load();
    } else {
      toast('error', 'Error', data?.error);
    }
  }

  async function openConfig(domain) {
    currentDomain = domain;
    const data = await api.get(`/api/domains/${domain}/config`);
    if (!data?.success) return toast('error', 'Error', data?.error);
    document.getElementById('configDomainName').textContent = domain;
    document.getElementById('configContent').value = data.data;
    openModal('modalViewConfig');
  }

  async function saveConfig() {
    const content = document.getElementById('configContent').value;
    const data = await api.put(`/api/domains/${currentDomain}`, { content });
    if (data?.success) {
      toast('success', 'Config saved', `${currentDomain} reloaded.`);
      closeModal('modalViewConfig');
    } else toast('error', 'Error', data?.error);
  }

  // ── Dynamic DNS preview in Add Domain modal ───────────────────────────────────
  function updateDnsPreview(value) {
    const host = (value || '').trim().toLowerCase().replace(/^https?:\/\//, '');
    const parts = host.split('.').filter(Boolean);
    const isSubdomain = parts.length > 2;

    const name1El   = document.getElementById('dnsName1');
    const name2El   = document.getElementById('dnsName2');
    const row2El    = document.getElementById('dnsRow2');
    const titleEl   = document.getElementById('dnsCalloutTitle');
    const descEl    = document.getElementById('dnsCalloutDesc');

    if (isSubdomain) {
      const sub = parts.slice(0, parts.length - 2).join('.');
      if (name1El) name1El.textContent = sub;
      if (row2El)  row2El.style.display = 'none';
      if (titleEl) titleEl.textContent = `Point ${host} to this server first`;
      if (descEl)  descEl.innerHTML = `Add this <strong style="color:var(--text-primary)">A record</strong> at your registrar for the <strong style="color:var(--text-primary)">${parts.slice(-2).join('.')}</strong> zone. No nameserver change needed.`;
    } else {
      if (name1El) name1El.textContent = '@';
      if (name2El) name2El.textContent = 'www';
      if (row2El)  row2El.style.display = 'grid';
      if (titleEl) titleEl.textContent = host ? `Point ${host} to this server first` : 'Point your domain to this server first';
      if (descEl)  descEl.innerHTML = `At your registrar (GoDaddy, Namecheap, etc.), add these <strong style="color:var(--text-primary)">DNS A records</strong>. You don't need to change nameservers.`;
    }
  }

  // ── Redirects manager ─────────────────────────────────────────────────────
  let _redirectDomain = null;

  async function openRedirects(domain) {
    _redirectDomain = domain;
    document.getElementById('redirectModalDomain').textContent = domain;
    document.getElementById('redirectFrom').value  = '';
    document.getElementById('redirectTo').value    = '';
    document.getElementById('redirectType').value  = '301';
    openModal('modalRedirects');
    await loadRedirects();
  }

  async function loadRedirects() {
    const tbody = document.getElementById('redirectsTable');
    if (!tbody || !_redirectDomain) return;
    tbody.innerHTML = '<tr><td colspan="4"><div class="empty-state"><p>Loading…</p></div></td></tr>';
    const data = await api.get(`/api/domains/${_redirectDomain}/redirects`);
    if (!data?.success) {
      tbody.innerHTML = `<tr><td colspan="4"><div class="empty-state"><p class="text-red">${data?.error}</p></div></td></tr>`;
      return;
    }
    if (!data.data.length) {
      tbody.innerHTML = '<tr><td colspan="4"><div class="empty-state"><p>No redirects yet.</p></div></td></tr>';
      return;
    }
    tbody.innerHTML = data.data.map(r => `
      <tr>
        <td class="td-mono text-sm">${r.from_path}</td>
        <td class="td-mono text-sm td-truncate" title="${r.to_url}">${r.to_url}</td>
        <td><span class="badge badge-${r.type === 301 ? 'blue' : 'amber'}">${r.type}</span></td>
        <td><button class="btn btn-danger btn-xs" onclick="window.domains.deleteRedirect(${r.id})">Remove</button></td>
      </tr>`).join('');
  }

  async function addRedirect() {
    const from_path = document.getElementById('redirectFrom').value.trim();
    const to_url    = document.getElementById('redirectTo').value.trim();
    const type      = parseInt(document.getElementById('redirectType').value, 10);
    if (!from_path || !to_url) return toast('error', 'Validation', 'From path and To URL are required');
    const data = await api.post(`/api/domains/${_redirectDomain}/redirects`, { from_path, to_url, type });
    if (data?.success) {
      document.getElementById('redirectFrom').value = '';
      document.getElementById('redirectTo').value   = '';
      toast('success', 'Redirect added', `${from_path} → ${to_url}`);
      loadRedirects();
    } else {
      toast('error', 'Error', data?.error);
    }
  }

  async function deleteRedirect(id) {
    const data = await api.del(`/api/domains/${_redirectDomain}/redirects/${id}`);
    if (data?.success) { toast('success', 'Removed', ''); loadRedirects(); }
    else toast('error', 'Error', data?.error);
  }

  function openAddModal() {
    updateDnsPreview('');
    openModal('modalAddDomain');
  }

  function openModal(id) {
    document.getElementById(id).classList.add('open');
  }
  function closeModal(id) {
    document.getElementById(id).classList.remove('open');
  }

  // Close on backdrop click
  document.querySelectorAll('.modal-backdrop').forEach(m => {
    m.addEventListener('click', e => { if (e.target === m) m.classList.remove('open'); });
  });

  // Close any open kebab menus when clicking outside. One handler, fires for
  // every <details class="row-menu"> anywhere in the panel.
  document.addEventListener('click', e => {
    document.querySelectorAll('details.row-menu[open]').forEach(d => {
      if (!d.contains(e.target)) d.removeAttribute('open');
    });
  }, true);
  // Esc also closes
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      document.querySelectorAll('details.row-menu[open]').forEach(d => d.removeAttribute('open'));
    }
  });

  // ── Domain Health detail modal ────────────────────────────────────────────

  const HEALTH_LABELS = {
    ssl:    'SSL Certificate',
    dns:    'DNS Resolution',
    mail:   'Mail Health',
    backup: 'Backups',
    disk:   'Disk Usage',
    php:    'PHP',
    errors: 'Recent Errors (24h)',
  };
  function _healthIcon(status) {
    switch (status) {
      case 'pass': return { ch: '✓', color: '#4ade80' };
      case 'warn': return { ch: '!', color: '#f59e0b' };
      case 'fail': return { ch: '✗', color: '#e05c6a' };
      case 'skip': return { ch: '–', color: '#7a86a0' };
      default:     return { ch: '·', color: '#7a86a0' };
    }
  }

  function _escHealth(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  async function openHealth(domain) {
    document.getElementById('healthModalDomain').textContent = domain;
    document.getElementById('healthModalBody').innerHTML = '<div class="empty-state"><p>Running checks…</p></div>';
    openModal('modalDomainHealth');

    const data = await api.get(`/api/domains/${domain}/health`);
    if (!data?.success) {
      document.getElementById('healthModalBody').innerHTML = `<div class="empty-state"><p class="text-red">${_escHealth(data?.error || 'Failed')}</p></div>`;
      return;
    }
    const r = data.data;

    const summaryIcon = _healthIcon(r.summary);
    const summaryLabel = r.summary === 'pass' ? 'All systems healthy'
                       : r.summary === 'warn' ? 'Warnings present'
                       : r.summary === 'fail' ? 'Failures need attention'
                       : 'Mixed';

    const checks = Object.entries(r.checks).map(([key, c]) => {
      const icon = _healthIcon(c.status);
      return `
        <div style="display:flex;align-items:flex-start;gap:var(--space-3);padding:var(--space-3);background:${icon.color}1a;border:1px solid var(--border);border-radius:var(--radius-sm)">
          <span style="display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:${icon.color}33;color:${icon.color};font-weight:700;flex-shrink:0">${icon.ch}</span>
          <div style="flex:1;min-width:0">
            <div style="font-weight:500;font-size:0.875rem;color:var(--text-primary)">${_escHealth(HEALTH_LABELS[key] || key)}</div>
            <div style="font-size:0.75rem;color:var(--text-muted);margin-top:2px;word-break:break-word">${_escHealth(c.detail || '')}</div>
          </div>
          <span style="font-size:0.6875rem;color:${icon.color};text-transform:uppercase;letter-spacing:0.06em;font-weight:600">${c.status}</span>
        </div>`;
    }).join('');

    document.getElementById('healthModalBody').innerHTML = `
      <div style="display:inline-flex;align-items:center;gap:var(--space-3);padding:var(--space-3) var(--space-4);background:${summaryIcon.color}1a;border:1px solid ${summaryIcon.color}40;border-radius:var(--radius-md);margin-bottom:var(--space-5)">
        <span style="display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:50%;background:${summaryIcon.color};color:#fff;font-weight:700">${summaryIcon.ch}</span>
        <div>
          <div style="font-weight:600;font-size:0.9375rem;color:var(--text-primary)">${_escHealth(summaryLabel)}</div>
          <div style="font-size:0.75rem;color:var(--text-muted);margin-top:2px">checked ${new Date(r.checked_at).toLocaleString()}</div>
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:var(--space-2)">${checks}</div>
    `;
  }

  return {
    load, add, toggle, confirmDelete, checkDeleteInput, submitDelete,
    openConfig, saveConfig, openAddModal, updateDnsPreview, showCredentials,
    copyCredField, downloadPrivateKey, generateAddKeypair,
    closeModal, openModal, openLogs, switchLogsTab,
    openRedirects, loadRedirects, addRedirect, deleteRedirect,
    openHealth,
  };
})();
