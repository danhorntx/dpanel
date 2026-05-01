'use strict';
window.cronMgr = (() => {
  const PRESETS = [
    { label: 'Every minute',         value: '* * * * *' },
    { label: 'Every 5 minutes',      value: '*/5 * * * *' },
    { label: 'Every 15 minutes',     value: '*/15 * * * *' },
    { label: 'Every hour',           value: '0 * * * *' },
    { label: 'Daily at midnight',    value: '0 0 * * *' },
    { label: 'Daily at 3am',         value: '0 3 * * *' },
    { label: 'Weekly (Sun midnight)',value: '0 0 * * 0' },
    { label: 'Monthly (1st midnight)',value: '0 0 1 * *' },
    { label: 'Custom…',              value: 'custom' },
  ];

  async function load() {
    const tbody = document.getElementById('cronTable');
    if (tbody) tbody.innerHTML = `<tr><td colspan="3"><div class="empty-state"><p>Loading…</p></div></td></tr>`;
    const data = await api.get('/api/cron');
    if (!data?.success) return toast('error', 'Cron', data?.error || 'Failed to load');
    render(data.data);
    populatePresets();
  }

  function render(jobs) {
    const tbody = document.getElementById('cronTable');
    if (!jobs.length) {
      tbody.innerHTML = `<tr><td colspan="3"><div class="empty-state"><h4>No cron jobs</h4><p>Add a scheduled task below.</p></div></td></tr>`;
      return;
    }
    tbody.innerHTML = jobs.map(j => `
      <tr>
        <td>
          <span class="badge badge-muted" style="font-family:var(--font-mono);font-size:0.75rem">${j.schedule}</span>
          <span style="font-size:0.75rem;color:var(--text-muted);margin-left:8px">${j.description}</span>
        </td>
        <td style="font-family:var(--font-mono);font-size:0.8125rem">${j.command}</td>
        <td style="text-align:right">
          <button class="btn btn-danger btn-xs" onclick="window.cronMgr.remove(${j.index})">Remove</button>
        </td>
      </tr>`).join('');
  }

  function populatePresets() {
    const sel = document.getElementById('cronSchedulePreset');
    if (!sel) return;
    sel.innerHTML = PRESETS.map(p => `<option value="${p.value}">${p.label}</option>`).join('');
    sel.onchange = () => {
      const custom = document.getElementById('cronScheduleCustom');
      if (sel.value === 'custom') {
        custom.style.display = '';
      } else {
        custom.style.display = 'none';
        custom.value = sel.value;
      }
    };
    // Init
    document.getElementById('cronScheduleCustom').style.display = 'none';
    document.getElementById('cronScheduleCustom').value = PRESETS[0].value;
  }

  async function add() {
    const preset   = document.getElementById('cronSchedulePreset').value;
    const custom   = document.getElementById('cronScheduleCustom').value.trim();
    const schedule = preset === 'custom' ? custom : preset;
    const command  = document.getElementById('cronCommand').value.trim();
    if (!schedule) return toast('error', 'Validation', 'Schedule required.');
    if (!command)  return toast('error', 'Validation', 'Command required.');
    const btn = document.getElementById('cronAddBtn');
    btn.disabled = true; btn.textContent = 'Adding…';
    const data = await api.post('/api/cron', { schedule, command });
    btn.disabled = false; btn.textContent = 'Add Job';
    if (data?.success) {
      toast('success', 'Cron job added', `${schedule} ${command}`);
      document.getElementById('cronCommand').value = '';
      load();
    } else toast('error', 'Failed', data?.error);
  }

  async function remove(index) {
    if (!confirm('Remove this cron job?')) return;
    const data = await api.del(`/api/cron/${index}`);
    if (data?.success) { toast('success', 'Removed', 'Cron job deleted.'); load(); }
    else toast('error', 'Failed', data?.error);
  }

  return { load, add, remove };
})();
