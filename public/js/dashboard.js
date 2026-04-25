// ── Dashboard module ──────────────────────────────────────────────────────────
window.dashboard = (() => {
  let pollTimer = null;

  function fmtBytes(b) {
    if (b >= 1e9) return (b / 1e9).toFixed(1) + ' GB';
    if (b >= 1e6) return (b / 1e6).toFixed(0) + ' MB';
    return (b / 1e3).toFixed(0) + ' KB';
  }

  function fmtUptime(secs) {
    const d = Math.floor(secs / 86400);
    const h = Math.floor((secs % 86400) / 3600);
    const m = Math.floor((secs % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  function setBar(id, pct) {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.width = Math.min(pct, 100) + '%';
    el.className = 'stat-bar-fill' + (pct > 90 ? ' danger' : pct > 75 ? ' warn' : '');
  }

  async function refresh() {
    try {
      const data = await api.get('/api/dashboard/stats');
      if (!data || !data.success) return;
      const d = data.data;

      // CPU
      const cpuEl = document.getElementById('statCpu');
      if (cpuEl) cpuEl.innerHTML = `${d.cpu}<span class="stat-unit">%</span>`;
      setBar('statCpuBar', d.cpu);

      // RAM
      const ramPct = Math.round(d.ram.used / d.ram.total * 100);
      const ramEl = document.getElementById('statRam');
      if (ramEl) ramEl.innerHTML = `${fmtBytes(d.ram.used)}`;
      const ramSub = document.getElementById('statRamSub');
      if (ramSub) ramSub.textContent = `of ${fmtBytes(d.ram.total)} — ${ramPct}%`;
      setBar('statRamBar', ramPct);

      // Disk
      if (d.disk) {
        const diskEl = document.getElementById('statDisk');
        if (diskEl) diskEl.innerHTML = `${d.disk.use}<span class="stat-unit">%</span>`;
        const diskSub = document.getElementById('statDiskSub');
        if (diskSub) diskSub.textContent = `${fmtBytes(d.disk.used)} of ${fmtBytes(d.disk.size)}`;
        setBar('statDiskBar', d.disk.use);
      }

      // Uptime
      const uptimeEl = document.getElementById('statUptime');
      if (uptimeEl) uptimeEl.innerHTML = fmtUptime(d.uptime);

      // Services
      const sg = document.getElementById('servicesGrid');
      if (sg) {
        const svcLabels = { apache2: 'Apache', postfix: 'Postfix', dovecot: 'Dovecot', spamassassin: 'SpamAssassin' };
        sg.innerHTML = Object.entries(d.services).map(([svc, running]) => `
          <div class="card-outer service-card">
            <div class="card-inner">
              <div class="service-dot ${running ? 'online' : 'offline'}"></div>
              <div>
                <div class="service-name">${svcLabels[svc] || svc}</div>
                <div class="service-status-text">${running ? 'Running' : 'Stopped'}</div>
              </div>
              <button class="btn btn-ghost btn-xs" style="margin-left:auto"
                onclick="dashboard.restart('${svc}')">Restart</button>
            </div>
          </div>`).join('');
      }

      // Hostname
      try {
        const hEl = document.getElementById('topbarHostname');
        if (hEl && hEl.textContent === 'loading...') {
          const h = await fetch('/api/dashboard/stats').then(()=>{});
          // Use location.hostname as fallback
          hEl.textContent = location.hostname;
        }
      } catch(_) {}

    } catch(err) { console.error('Stats fetch error:', err); }

    // Recent log
    try {
      const logData = await api.get('/api/dashboard/log');
      const el = document.getElementById('actionLog');
      if (el && logData && logData.success) {
        if (!logData.data.length) {
          el.innerHTML = `<div class="empty-state" style="padding:var(--space-6)"><p class="text-sm text-muted">No actions logged yet.</p></div>`;
        } else {
          el.innerHTML = logData.data.map(e => `
            <div class="action-log-entry">
              <span class="log-ts">${e.ts ? new Date(e.ts).toLocaleString() : ''}</span>
              <span class="log-action">${e.action || ''}</span>
              <span class="log-target">${e.target || ''}</span>
              <span class="log-result ${e.result === 'ok' ? 'text-green' : 'text-red'}">${e.result || ''}</span>
            </div>`).join('');
        }
      }
    } catch(_) {}
  }

  async function restart(svc) {
    try {
      await api.post('/api/dashboard/stats', {}); // dummy — use shell directly
      toast('warning', `Restarting ${svc}...`);
      // We'll hit the domains route which uses shell — but for services we need a direct endpoint
      // For now show a message
      toast('warning', 'Restart', `Use the Terminal to run: systemctl restart ${svc}`);
    } catch(e) { toast('error', 'Error', e.message); }
  }

  function init() {
    // Set hostname
    const hEl = document.getElementById('topbarHostname');
    if (hEl) hEl.textContent = location.hostname;

    refresh();
    pollTimer = setInterval(refresh, 10000);
  }

  return { init, refresh, restart };
})();
