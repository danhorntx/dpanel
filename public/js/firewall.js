'use strict';
window.firewallMgr = (() => {

  async function load() {
    const tbody = document.getElementById('firewallTable');
    if (tbody) tbody.innerHTML = `<tr><td colspan="4"><div class="empty-state"><p>Loading…</p></div></td></tr>`;
    const data = await api.get('/api/firewall');
    if (!data?.success) return toast('error', 'Firewall', data?.error || 'Failed to load');

    const statusEl = document.getElementById('firewallStatus');
    const enableBtn = document.getElementById('firewallEnableBtn');
    if (data.data.enabled) {
      if (statusEl) { statusEl.textContent = 'Active'; statusEl.className = 'badge badge-green'; }
      if (enableBtn) { enableBtn.textContent = 'Disable UFW'; enableBtn.onclick = disable; }
    } else {
      if (statusEl) { statusEl.textContent = 'Inactive'; statusEl.className = 'badge badge-muted'; }
      if (enableBtn) { enableBtn.textContent = 'Enable UFW'; enableBtn.onclick = enable; }
    }

    render(data.data.rules);
  }

  function render(rules) {
    const tbody = document.getElementById('firewallTable');
    if (!rules.length) {
      tbody.innerHTML = `<tr><td colspan="4"><div class="empty-state"><h4>No rules</h4><p>UFW may not be active or has no numbered rules.</p></div></td></tr>`;
      return;
    }
    tbody.innerHTML = rules.map(r => `
      <tr>
        <td style="font-family:var(--font-mono);font-size:0.8125rem">${r.to || r.raw}</td>
        <td>
          <span class="badge ${r.action === 'ALLOW' ? 'badge-green' : 'badge-red'}">${r.action || '—'}</span>
        </td>
        <td style="font-size:0.8125rem;color:var(--text-muted)">${r.from || 'Anywhere'}</td>
        <td style="text-align:right">
          <button class="btn btn-danger btn-xs" onclick="window.firewallMgr.deleteRule(${r.num})">Delete</button>
        </td>
      </tr>`).join('');
  }

  async function enable() {
    toast('warning', 'Enabling UFW…', 'Ensure port 22 is open first.');
    const data = await api.post('/api/firewall/enable', {});
    if (data?.success) { toast('success', 'UFW enabled', ''); load(); }
    else toast('error', 'Failed', data?.error);
  }

  async function disable() {
    if (!confirm('Disable the firewall? All rules will be inactive.')) return;
    const data = await api.post('/api/firewall/disable', {});
    if (data?.success) { toast('success', 'UFW disabled', ''); load(); }
    else toast('error', 'Failed', data?.error);
  }

  async function addRule() {
    const port    = document.getElementById('fwPort').value.trim();
    const proto   = document.getElementById('fwProto').value;
    const action  = document.getElementById('fwAction').value;
    const comment = document.getElementById('fwComment').value.trim();
    if (!port) return toast('error', 'Validation', 'Port required.');
    const endpoint = action === 'allow' ? '/api/firewall/allow' : '/api/firewall/deny';
    const btn = document.getElementById('fwAddBtn');
    btn.disabled = true; btn.textContent = 'Adding…';
    const data = await api.post(endpoint, { port, proto, comment });
    btn.disabled = false; btn.textContent = 'Add Rule';
    if (data?.success) {
      toast('success', 'Rule added', `${action} ${port}/${proto}`);
      document.getElementById('fwPort').value    = '';
      document.getElementById('fwComment').value = '';
      load();
    } else toast('error', 'Failed', data?.error);
  }

  async function blockIp() {
    const ip = document.getElementById('fwBlockIp').value.trim();
    if (!ip) return toast('error', 'Validation', 'IP address required.');
    const data = await api.post('/api/firewall/block-ip', { ip });
    if (data?.success) {
      toast('success', 'IP blocked', ip);
      document.getElementById('fwBlockIp').value = '';
      load();
    } else toast('error', 'Failed', data?.error);
  }

  async function deleteRule(num) {
    if (!confirm(`Delete rule #${num}?`)) return;
    const data = await api.del(`/api/firewall/${num}`);
    if (data?.success) { toast('success', 'Rule deleted', ''); load(); }
    else toast('error', 'Failed', data?.error);
  }

  return { load, enable, disable, addRule, blockIp, deleteRule };
})();
