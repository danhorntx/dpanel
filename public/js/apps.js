'use strict';
window.appsMgr = (() => {
  let _domains = [];

  async function load() {
    setLoading('wpTable', 4);
    setLoading('gitTable', 4);
    const data = await api.get('/api/wordpress');
    if (!data?.success) return toast('error', 'Apps', data?.error || 'Failed to load');
    _domains = data.data.installs || [];
    renderWordPress(_domains);
    populateWpDomainSelect(_domains);
    await loadGit();
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
    btn.disabled = true; btn.textContent = 'Installing…';
    toast('warning', 'Installing WordPress…', 'Downloading and configuring, please wait.');
    const data = await api.post('/api/wordpress/install', { domain, siteTitle, adminUser, adminEmail, adminPassword: adminPw || undefined });
    btn.disabled = false; btn.textContent = 'Install';
    if (data?.success) {
      document.getElementById('modalInstallWP').classList.remove('open');
      const d = data.data;
      document.getElementById('wpCredsUrl').textContent      = `https://${d.domain}/wp-admin`;
      document.getElementById('wpCredsAdminUser').textContent = d.adminUser;
      document.getElementById('wpCredsAdminPw').textContent   = d.adminPassword;
      document.getElementById('wpCredsDbName').textContent    = d.dbName;
      document.getElementById('wpCredsDbUser').textContent    = d.dbUser;
      document.getElementById('wpCredsDbPw').textContent      = d.dbPassword;
      document.getElementById('modalWpCreds').classList.add('open');
      load();
    } else toast('error', 'Install failed', data?.error);
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

  return { load, openWpInstall, submitWpInstall, copyWpCred, openGitConfig, saveGitConfig, deploy };
})();
