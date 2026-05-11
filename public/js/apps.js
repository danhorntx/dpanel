'use strict';
window.appsMgr = (() => {
  let _domains  = [];
  let _nodeApps = [];

  async function load() {
    setLoading('wpTable', 4);
    setLoading('gitTable', 4);
    setLoading('nodeAppsTable', 7);
    const data = await api.get('/api/wordpress');
    if (!data?.success) return toast('error', 'Apps', data?.error || 'Failed to load');
    _domains = data.data.installs || [];
    renderWordPress(_domains);
    populateWpDomainSelect(_domains);
    await loadGit();
    await loadNodeApps();
  }

  function setLoading(id, cols) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = `<tr><td colspan="${cols}"><div class="empty-state"><p>Loading…</p></div></td></tr>`;
  }

  // ── WordPress ──────────────────────────────────────────────────────────────
  function renderWordPress(installs) {
    const tbody = document.getElementById('wpTable');
    if (!installs.length) {
      tbody.innerHTML = `<tr><td colspan="4"><div class="empty-state"><h4>No domains configured</h4><p>Add a domain first, then install WordPress.</p></div></td></tr>`;
      return;
    }
    tbody.innerHTML = installs.map(i => `
      <tr>
        <td><span class="font-medium">${i.domain}</span></td>
        <td>
          ${i.installed
            ? `<span class="badge badge-green"><span class="badge-dot"></span>Installed ${i.version ? `v${i.version}` : ''}</span>`
            : `<span class="badge badge-muted">Not installed</span>`}
        </td>
        <td style="font-size:0.8125rem;color:var(--text-muted);font-family:var(--font-mono)">${i.docRoot}</td>
        <td style="text-align:right">
          ${!i.installed
            ? `<button class="btn btn-primary btn-xs" onclick="window.appsMgr.openWpInstall('${i.domain}')">Install WordPress</button>`
            : `<a class="btn btn-ghost btn-xs" href="https://${i.domain}/wp-admin" target="_blank">WP Admin →</a>`}
        </td>
      </tr>`).join('');
  }

  function populateWpDomainSelect(installs) {
    const sel = document.getElementById('wpDomain');
    if (!sel) return;
    sel.innerHTML = installs.filter(i => !i.installed).map(i => `<option value="${i.domain}">${i.domain}</option>`).join('');
  }

  function openWpInstall(domain) {
    const sel = document.getElementById('wpDomain');
    if (sel) sel.value = domain;
    document.getElementById('wpSiteTitle').value  = '';
    document.getElementById('wpAdminUser').value  = 'admin';
    document.getElementById('wpAdminEmail').value = '';
    document.getElementById('wpAdminPw').value    = '';
    document.getElementById('modalInstallWP').classList.add('open');
  }

  async function submitWpInstall() {
    const domain      = document.getElementById('wpDomain').value;
    const siteTitle   = document.getElementById('wpSiteTitle').value.trim() || domain;
    const adminUser   = document.getElementById('wpAdminUser').value.trim()  || 'admin';
    const adminEmail  = document.getElementById('wpAdminEmail').value.trim();
    const adminPw     = document.getElementById('wpAdminPw').value;
    if (!domain)     return toast('error', 'Validation', 'Select a domain.');
    if (!adminEmail) return toast('error', 'Validation', 'Admin email required.');
    const btn = document.getElementById('wpInstallBtn');
    btn.disabled = true; btn.textContent = 'Queueing…';
    const data = await api.post('/api/wordpress/install', { domain, siteTitle, adminUser, adminEmail, adminPassword: adminPw || undefined });
    if (!data?.success || !data.jobId) {
      btn.disabled = false; btn.textContent = 'Install';
      return toast('error', 'Install failed', data?.error || 'No job ID returned');
    }
    // Server returned a jobId — poll until done. WordPress install runs ~60-120s.
    btn.textContent = 'Installing…';
    toast('warning', 'Installing WordPress…', 'This typically takes 1-2 minutes.');
    const result = await _pollJob(data.jobId, (job) => {
      btn.textContent = `${job.progress || 0}%${job.progress_msg ? ' · ' + job.progress_msg : ''}`;
    });
    btn.disabled = false; btn.textContent = 'Install';
    if (result.state === 'done') {
      document.getElementById('modalInstallWP').classList.remove('open');
      const d = result.result;
      document.getElementById('wpCredsUrl').textContent      = `https://${d.domain}/wp-admin`;
      document.getElementById('wpCredsAdminUser').textContent = d.adminUser;
      document.getElementById('wpCredsAdminPw').textContent   = d.adminPassword;
      document.getElementById('wpCredsDbName').textContent    = d.dbName;
      document.getElementById('wpCredsDbUser').textContent    = d.dbUser;
      document.getElementById('wpCredsDbPw').textContent      = d.dbPassword;
      document.getElementById('modalWpCreds').classList.add('open');
      load();
    } else {
      toast('error', 'Install failed', result.error || 'Unknown error');
    }
  }

  // Generic job poller. Calls onProgress every 2s while the job is running.
  async function _pollJob(jobId, onProgress) {
    while (true) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        const data = await api.get(`/api/jobs/${jobId}`);
        if (!data?.success) return { state: 'failed', error: data?.error || 'Job lookup failed' };
        const job = data.data;
        if (job.state === 'done' || job.state === 'failed' || job.state === 'cancelled') return job;
        if (onProgress) onProgress(job);
      } catch (e) {
        return { state: 'failed', error: e.message };
      }
    }
  }

  function copyWpCred(id) {
    const el = document.getElementById(id);
    if (!el) return;
    navigator.clipboard.writeText(el.textContent).then(() => toast('success', 'Copied', ''));
  }

  // ── Git Deploy ─────────────────────────────────────────────────────────────
  async function loadGit() {
    const tbody = document.getElementById('gitTable');
    if (tbody) tbody.innerHTML = `<tr><td colspan="4"><div class="empty-state"><p>Loading…</p></div></td></tr>`;
    const data = await api.get('/api/git');
    if (!data?.success) return;
    renderGit(data.data);
  }

  function renderGit(deploys) {
    const tbody = document.getElementById('gitTable');
    if (!deploys.length) {
      tbody.innerHTML = `<tr><td colspan="4"><div class="empty-state"><h4>No domains</h4><p>Add a domain first.</p></div></td></tr>`;
      return;
    }
    tbody.innerHTML = deploys.map(d => {
      const cfg = d.config;
      return `
        <tr>
          <td><span class="font-medium">${d.domain}</span></td>
          <td>
            ${cfg
              ? `<span style="font-family:var(--font-mono);font-size:0.8125rem">${cfg.repoUrl}</span><br>
                 <span style="font-size:0.75rem;color:var(--text-muted)">branch: ${cfg.branch} ${cfg.lastCommit ? '· ' + cfg.lastCommit : ''}</span>`
              : `<span style="color:var(--text-muted);font-size:0.8125rem">Not configured</span>`}
          </td>
          <td style="font-size:0.8125rem;color:var(--text-muted)">
            ${cfg?.lastDeploy ? new Date(cfg.lastDeploy).toLocaleString() : '—'}
          </td>
          <td style="text-align:right;display:flex;gap:6px;justify-content:flex-end">
            <button class="btn btn-ghost btn-xs" onclick="window.appsMgr.openGitConfig('${d.domain}')">Configure</button>
            ${cfg ? `<button class="btn btn-primary btn-xs" onclick="window.appsMgr.deploy('${d.domain}')">Deploy</button>` : ''}
          </td>
        </tr>`;
    }).join('');
  }

  let _gitDomain = null;
  function openGitConfig(domain) {
    _gitDomain = domain;
    document.getElementById('gitConfigDomain').textContent = domain;
    // Load existing config
    api.get(`/api/git/${domain}`).then(data => {
      if (data?.data) {
        const cfg = data.data;
        document.getElementById('gitRepoUrl').value     = cfg.repoUrl     || '';
        document.getElementById('gitBranch').value      = cfg.branch      || 'main';
        document.getElementById('gitBuildCmd').value    = cfg.buildCommand || '';
        const host = window.location.hostname;
        document.getElementById('gitWebhookUrl').value = `https://${host}/api/git/webhook/${domain}`;
        document.getElementById('gitWebhookSecret').value = cfg.webhookSecret || '';
      } else {
        document.getElementById('gitRepoUrl').value     = '';
        document.getElementById('gitBranch').value      = 'main';
        document.getElementById('gitBuildCmd').value    = '';
        document.getElementById('gitWebhookUrl').value  = '';
        document.getElementById('gitWebhookSecret').value = '';
      }
    });
    document.getElementById('modalGitConfig').classList.add('open');
  }

  async function saveGitConfig() {
    if (!_gitDomain) return;
    const repoUrl      = document.getElementById('gitRepoUrl').value.trim();
    const branch       = document.getElementById('gitBranch').value.trim() || 'main';
    const buildCommand = document.getElementById('gitBuildCmd').value.trim();
    if (!repoUrl) return toast('error', 'Validation', 'Repository URL required.');
    const data = await api.post(`/api/git/${_gitDomain}`, { repoUrl, branch, buildCommand });
    document.getElementById('modalGitConfig').classList.remove('open');
    if (data?.success) {
      toast('success', 'Git deploy configured', _gitDomain);
      const secret = data.data?.webhookSecret;
      if (secret) {
        document.getElementById('gitWebhookUrl').value    = `https://${window.location.hostname}/api/git/webhook/${_gitDomain}`;
        document.getElementById('gitWebhookSecret').value = secret;
      }
      loadGit();
    } else toast('error', 'Failed', data?.error);
  }

  async function deploy(domain) {
    const btn = [...document.querySelectorAll(`[onclick*="deploy('${domain}')"]`)][0];
    if (btn) { btn.disabled = true; btn.textContent = 'Deploying…'; }
    toast('warning', 'Deploying…', domain);
    const data = await api.post(`/api/git/${domain}/deploy`, {});
    if (btn) { btn.disabled = false; btn.textContent = 'Deploy'; }
    if (data?.success) {
      const commit = data.data?.commit;
      toast('success', 'Deployed', commit ? `${domain} @ ${commit}` : domain);
      loadGit();
    } else toast('error', 'Deploy failed', data?.error);
  }

  // ── Node / Python Apps ─────────────────────────────────────────────────────

  function _escApp(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }
  function _fmtUptime(ms) {
    if (!ms || ms < 1000) return '—';
    const s = Math.floor(ms / 1000);
    if (s < 60)    return `${s}s`;
    if (s < 3600)  return `${Math.floor(s/60)}m`;
    if (s < 86400) return `${Math.floor(s/3600)}h`;
    return `${Math.floor(s/86400)}d`;
  }

  async function loadNodeApps() {
    const tbody = document.getElementById('nodeAppsTable');
    if (!tbody) return;
    const data = await api.get('/api/apps');
    if (!data?.success) {
      tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><p class="text-red">${_escApp(data?.error || 'Failed to load')}</p></div></td></tr>`;
      return;
    }
    _nodeApps = data.data;
    if (!_nodeApps.length) {
      tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><h4>No apps deployed</h4><p>Click "Deploy App" to start your first Node or Python service.</p></div></td></tr>`;
      return;
    }
    const stateBadge = (s) => {
      if (s === 'online')  return '<span class="badge badge-green"><span class="badge-dot"></span>running</span>';
      if (s === 'stopped') return '<span class="badge badge-muted">stopped</span>';
      if (s === 'errored') return '<span class="badge badge-red">errored</span>';
      if (s === 'absent')  return '<span class="badge badge-amber">not in PM2</span>';
      return `<span class="badge badge-muted">${_escApp(s)}</span>`;
    };
    tbody.innerHTML = _nodeApps.map(a => `
      <tr>
        <td><span class="font-medium" style="font-family:var(--font-mono);font-size:0.8125rem">${_escApp(a.name)}</span></td>
        <td><span style="font-family:var(--font-mono);font-size:0.8125rem;color:var(--text-muted)">${_escApp(a.domain)}</span></td>
        <td>${stateBadge(a.pm2?.state)}</td>
        <td style="font-family:var(--font-mono);font-size:0.8125rem;color:var(--text-muted)">${a.port}</td>
        <td style="font-size:0.8125rem;color:var(--text-muted)">${_fmtUptime(a.pm2?.uptimeMs)}</td>
        <td style="font-size:0.8125rem;color:var(--text-muted)">${a.pm2?.memMb != null ? a.pm2.memMb + ' MB' : '—'}</td>
        <td style="text-align:right;display:flex;gap:4px;justify-content:flex-end;flex-wrap:wrap">
          <button class="btn btn-ghost btn-xs" onclick="window.appsMgr.restartApp('${_escApp(a.name)}')">Restart</button>
          ${a.pm2?.state === 'online'
            ? `<button class="btn btn-ghost btn-xs" onclick="window.appsMgr.stopApp('${_escApp(a.name)}')">Stop</button>`
            : `<button class="btn btn-ghost btn-xs" onclick="window.appsMgr.startApp('${_escApp(a.name)}')">Start</button>`}
          <button class="btn btn-ghost btn-xs" onclick="window.appsMgr.viewLogs('${_escApp(a.name)}')">Logs</button>
          <button class="btn btn-danger btn-xs" onclick="window.appsMgr.destroyApp('${_escApp(a.name)}','${_escApp(a.domain)}')">Destroy</button>
        </td>
      </tr>`).join('');
  }

  // ── Deploy modal ───────────────────────────────────────────────────────────
  async function openNewAppModal() {
    document.getElementById('newAppName').value     = '';
    document.getElementById('newAppRuntime').value  = 'node';
    document.getElementById('newAppStartCmd').value = 'npm start';
    document.getElementById('newAppEnv').value      = '';
    document.getElementById('newAppError').style.display = 'none';

    // Domain dropdown — from /api/domains, excluding ones already wired to an app
    const taken = new Set(_nodeApps.map(a => a.domain));
    const domData = await api.get('/api/domains');
    const sel = document.getElementById('newAppDomain');
    const opts = (domData?.data || []).filter(d => !taken.has(d.domain));
    if (!opts.length) {
      sel.innerHTML = '<option value="">No free domains — provision one first</option>';
    } else {
      sel.innerHTML = opts.map(d => `<option value="${_escApp(d.domain)}">${_escApp(d.domain)}</option>`).join('');
    }

    document.getElementById('modalNewApp').classList.add('open');
    setTimeout(() => document.getElementById('newAppName').focus(), 50);
  }

  function closeNewAppModal() { document.getElementById('modalNewApp').classList.remove('open'); }

  function onRuntimeChange() {
    const runtime = document.getElementById('newAppRuntime').value;
    const input   = document.getElementById('newAppStartCmd');
    if (runtime === 'node')        input.value = 'npm start';
    else if (runtime === 'python') input.value = 'python3 app.py';
    // custom: leave as-is
  }

  async function submitNewApp() {
    const name        = document.getElementById('newAppName').value.trim();
    const domain      = document.getElementById('newAppDomain').value;
    const runtime     = document.getElementById('newAppRuntime').value;
    const startCommand = document.getElementById('newAppStartCmd').value.trim();
    const envText     = document.getElementById('newAppEnv').value.trim();
    const errEl       = document.getElementById('newAppError');
    errEl.style.display = 'none';

    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
      errEl.textContent = 'Name must be 1-64 chars [a-zA-Z0-9_-].';
      errEl.style.display = 'block'; return;
    }
    if (!domain)       { errEl.textContent = 'Pick a domain.';        errEl.style.display = 'block'; return; }
    if (!startCommand) { errEl.textContent = 'Start command required.'; errEl.style.display = 'block'; return; }

    // Parse env block
    const env = {};
    for (const line of envText.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx < 1) { errEl.textContent = `Bad env line: "${trimmed}"`; errEl.style.display = 'block'; return; }
      env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
    }

    const btn = document.getElementById('newAppDeployBtn');
    btn.disabled = true; btn.textContent = 'Deploying…';
    const data = await api.post('/api/apps', { name, domain, runtime, startCommand, env });
    btn.disabled = false; btn.textContent = 'Deploy';

    if (data?.success) {
      toast('success', 'Deployed', `${name} on port ${data.data.port}`);
      closeNewAppModal();
      loadNodeApps();
    } else {
      errEl.textContent = data?.error || 'Deploy failed';
      errEl.style.display = 'block';
    }
  }

  async function restartApp(name) {
    const data = await api.post(`/api/apps/${encodeURIComponent(name)}/restart`, {});
    if (data?.success) { toast('success', 'Restarted', name); loadNodeApps(); }
    else toast('error', 'Failed', data?.error);
  }
  async function stopApp(name) {
    const data = await api.post(`/api/apps/${encodeURIComponent(name)}/stop`, {});
    if (data?.success) { toast('success', 'Stopped', name); loadNodeApps(); }
    else toast('error', 'Failed', data?.error);
  }
  async function startApp(name) {
    const data = await api.post(`/api/apps/${encodeURIComponent(name)}/start`, {});
    if (data?.success) { toast('success', 'Started', name); loadNodeApps(); }
    else toast('error', 'Failed', data?.error);
  }

  async function destroyApp(name, domain) {
    if (!confirm(`Destroy app "${name}"?\n\nThis stops the PM2 process, removes the reverse-proxy vhost, and restores a plain placeholder vhost for ${domain}.`)) return;
    const data = await api.del(`/api/apps/${encodeURIComponent(name)}`);
    if (data?.success) { toast('success', 'Destroyed', name); loadNodeApps(); }
    else toast('error', 'Failed', data?.error);
  }

  // ── Logs modal ─────────────────────────────────────────────────────────────
  let _logsName = null;
  async function viewLogs(name) {
    _logsName = name;
    document.getElementById('appLogsName').textContent = name;
    document.getElementById('appLogsStdout').textContent = 'Loading…';
    document.getElementById('appLogsStderr').textContent = '';
    document.getElementById('modalAppLogs').classList.add('open');
    await refreshLogs();
  }
  async function refreshLogs() {
    if (!_logsName) return;
    const data = await api.get(`/api/apps/${encodeURIComponent(_logsName)}/logs?lines=200`);
    if (!data?.success) {
      document.getElementById('appLogsStdout').textContent = `Error: ${data?.error || 'failed'}`;
      return;
    }
    document.getElementById('appLogsStdout').textContent = data.data.stdout || '(empty)';
    document.getElementById('appLogsStderr').textContent = data.data.stderr || '(empty)';
  }
  function closeLogsModal() {
    document.getElementById('modalAppLogs').classList.remove('open');
    _logsName = null;
  }

  return {
    load, openWpInstall, submitWpInstall, copyWpCred, openGitConfig, saveGitConfig, deploy,
    loadNodeApps, openNewAppModal, closeNewAppModal, onRuntimeChange, submitNewApp,
    restartApp, stopApp, startApp, destroyApp,
    viewLogs, refreshLogs, closeLogsModal,
  };
})();
