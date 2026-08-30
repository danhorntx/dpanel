// ── DNS Manager module ────────────────────────────────────────────────────────
window.dnsMgr = (() => {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────────
  let zones      = [];
  let activeZone = null;
  let records    = [];
  let nsInfo     = { ns1: 'ns1.danhorntx.com', ns2: 'ns2.danhorntx.com', serverIp: '' };
  let initialized = false;

  // ── API helpers ────────────────────────────────────────────────────────────
  async function apiGet(url) {
    const res = await fetch(url, { credentials: 'include' });
    if (res.status === 401) { window.location.href = '/'; return {}; }
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Request failed');
    return data;
  }

  async function apiPost(url, body) {
    const res = await fetch(url, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    if (res.status === 401) { window.location.href = '/'; return {}; }
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Request failed');
    return data;
  }

  async function apiDelete(url, body) {
    const res = await fetch(url, {
      method: 'DELETE', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    if (res.status === 401) { window.location.href = '/'; return {}; }
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Request failed');
    return data;
  }

  // ── DOM helpers ────────────────────────────────────────────────────────────
  const $ = id => document.getElementById(id);

  // ── Render zone list ───────────────────────────────────────────────────────
  function renderZoneList() {
    const el = $('dnsZoneList');
    if (!el) return;
    if (!zones.length) {
      el.innerHTML = '<div style="font-size:0.8rem;color:var(--text-muted);padding:var(--space-3)">No zones yet. Click Add Zone.</div>';
      return;
    }
    el.innerHTML = zones.map(z => `
      <div class="dns-zone-item${activeZone === z.domain ? ' active' : ''}"
           data-domain="${z.domain}" role="button" tabindex="0"
           style="display:flex;align-items:center;justify-content:space-between;padding:6px 8px;border-radius:var(--radius-sm);cursor:pointer;font-size:0.8rem;${activeZone === z.domain ? 'background:var(--accent-dim);color:var(--accent)' : 'color:var(--text-secondary)'}">
        <span style="font-family:var(--font-mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${z.domain}</span>
        <span style="font-size:0.7rem;color:var(--text-muted);flex-shrink:0;margin-left:4px">${z.recordCount}</span>
      </div>
    `).join('');

    el.querySelectorAll('[data-domain]').forEach(item => {
      item.addEventListener('click', () => selectZone(item.dataset.domain));
      item.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectZone(item.dataset.domain); }
      });
    });
  }

  // ── Select zone ────────────────────────────────────────────────────────────
  async function selectZone(domain) {
    activeZone = domain;
    renderZoneList();
    const lbl = $('dnsActiveZoneLabel');
    if (lbl) lbl.textContent = domain;
    $('dnsNoZoneMsg') && ($('dnsNoZoneMsg').style.display = 'none');
    $('dnsRecordTable') && ($('dnsRecordTable').style.display = '');
    $('dnsAddRecordBtn') && ($('dnsAddRecordBtn').disabled = false);
    $('dnsMailSetupBtn') && ($('dnsMailSetupBtn').disabled = false);
    $('dnsDeleteZoneBtn') && ($('dnsDeleteZoneBtn').disabled = false);
    await loadRecords(domain);
  }

  // ── Load records ───────────────────────────────────────────────────────────
  async function loadRecords(domain) {
    const tbody = $('dnsRecordsTbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:var(--space-4)">Loading…</td></tr>';
    try {
      const res = await apiGet('/api/dns/zones/' + domain + '/records');
      records = (res.data && res.data.records) || [];
      renderRecords();
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="5" style="color:var(--accent-red);padding:var(--space-3)">${err.message}</td></tr>`;
    }
  }

  // ── Render records table ───────────────────────────────────────────────────
  function renderRecords() {
    const tbody = $('dnsRecordsTbody');
    if (!tbody) return;
    if (!records.length) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:var(--space-5)">No records in this zone.</td></tr>';
      return;
    }

    const TYPE_COLORS = {
      A: '#4ade80', AAAA: '#60a5fa', CNAME: '#f59e0b',
      MX: '#a78bfa', TXT: '#94a3b8', SRV: '#fb7185', CAA: '#fb923c',
    };

    tbody.innerHTML = records.map((r, i) => {
      const col = TYPE_COLORS[r.type] || '#94a3b8';
      const display = r.type === 'MX' ? r.priority + ' ' + r.value : r.value;
      const short   = display.length > 60 ? display.slice(0, 57) + '…' : display;
      const safeVal = encodeURIComponent(r.value);
      return `<tr>
        <td style="font-family:var(--font-mono);font-size:0.78rem">${r.name}</td>
        <td><span style="background:${col}20;color:${col};border:1px solid ${col}40;border-radius:3px;font-size:0.7rem;padding:1px 6px;font-weight:600;letter-spacing:.04em">${r.type}</span></td>
        <td style="color:var(--text-muted);font-size:0.78rem">${r.ttl}</td>
        <td style="font-family:var(--font-mono);font-size:0.78rem;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${display.replace(/"/g, '&quot;')}">${short}</td>
        <td>
          <button class="btn btn-sm btn-danger" data-dns-del data-index="${i}"
            data-name="${r.name}" data-type="${r.type}" data-value="${safeVal}"
            style="padding:2px 8px" title="Delete record">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/>
            </svg>
          </button>
        </td>
      </tr>`;
    }).join('');

    tbody.querySelectorAll('[data-dns-del]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const name  = btn.dataset.name;
        const type  = btn.dataset.type;
        const value = decodeURIComponent(btn.dataset.value);
        if (!confirm(`Delete ${type} record for "${name}"?`)) return;
        btn.disabled = true;
        try {
          await apiDelete('/api/dns/zones/' + activeZone + '/records', { name, type, value });
          await Promise.all([loadRecords(activeZone), loadZones()]);
          window.toast && window.toast('success', 'Record deleted', '');
        } catch (err) {
          window.toast ? window.toast('error', 'Error', err.message) : alert(err.message);
          btn.disabled = false;
        }
      });
    });
  }

  // ── Load zone list ─────────────────────────────────────────────────────────
  async function loadZones() {
    try {
      const res = await apiGet('/api/dns/zones');
      zones = res.data || [];
      renderZoneList();
      if (activeZone && !zones.find(z => z.domain === activeZone)) {
        activeZone = null;
        $('dnsNoZoneMsg') && ($('dnsNoZoneMsg').style.display = '');
        $('dnsRecordTable') && ($('dnsRecordTable').style.display = 'none');
        $('dnsAddRecordBtn') && ($('dnsAddRecordBtn').disabled = true);
        $('dnsMailSetupBtn') && ($('dnsMailSetupBtn').disabled = true);
        $('dnsDeleteZoneBtn') && ($('dnsDeleteZoneBtn').disabled = true);
        if ($('dnsActiveZoneLabel')) $('dnsActiveZoneLabel').textContent = '—';
      }
    } catch (err) {
      console.error('DNS: failed to load zones', err);
    }
  }

  // ── Load NS info ───────────────────────────────────────────────────────────
  async function loadNsInfo() {
    try {
      const res = await apiGet('/api/dns/info');
      nsInfo = res.data || nsInfo;
      const box = $('dnsNsInfo');
      if (box) {
        box.innerHTML = `
          <div style="display:flex;gap:var(--space-5);padding:var(--space-3) var(--space-4);background:var(--bg-raised);border:1px solid var(--border);border-radius:var(--radius-md);font-size:0.8rem">
            <div><span style="color:var(--text-muted);margin-right:8px">NS1</span><code style="color:var(--accent)">${nsInfo.ns1}</code></div>
            <div><span style="color:var(--text-muted);margin-right:8px">NS2</span><code style="color:var(--accent)">${nsInfo.ns2}</code></div>
            <div><span style="color:var(--text-muted);margin-right:8px">Server IP</span><code style="color:var(--text-primary)">${nsInfo.serverIp}</code></div>
          </div>`;
      }
    } catch (_) {}
  }

  // ── Modal helpers ──────────────────────────────────────────────────────────
  // Use classList.add/remove('open') — matches the CSS opacity/pointer-events
  // system used by every other modal in dashboard.html.
  function openModal(id) {
    const m = $(id);
    if (m) m.classList.add('open');
  }
  function closeModal(id) {
    const m = $(id);
    if (m) m.classList.remove('open');
  }

  function showAddZone() {
    if ($('dnsNewDomain')) $('dnsNewDomain').value = '';
    if ($('dnsNewIp'))     $('dnsNewIp').value     = nsInfo.serverIp || '';
    openModal('dnsAddZoneModal');
    if ($('dnsNewDomain')) $('dnsNewDomain').focus();
  }

  function showAddRecord() {
    if (!activeZone) return;
    ['dnsRecName','dnsRecValue'].forEach(id => { if ($(id)) $(id).value = ''; });
    if ($('dnsRecType'))     $('dnsRecType').value     = 'A';
    if ($('dnsRecTtl'))      $('dnsRecTtl').value      = '14400';
    if ($('dnsRecPriority')) $('dnsRecPriority').value = '10';
    updatePriorityRow();
    openModal('dnsAddRecordModal');
    if ($('dnsRecName')) $('dnsRecName').focus();
  }

  function updatePriorityRow() {
    const type = $('dnsRecType') && $('dnsRecType').value;
    const row  = $('dnsRecPriorityRow');
    if (row) row.style.display = (type === 'MX' || type === 'SRV') ? '' : 'none';
  }

  // ── Wire events (once) ─────────────────────────────────────────────────────
  function wireEvents() {
    // Add Zone button
    $('dnsAddZoneBtn') && $('dnsAddZoneBtn').addEventListener('click', showAddZone);

    // Add Record button
    $('dnsAddRecordBtn') && $('dnsAddRecordBtn').addEventListener('click', () => {
      if (activeZone) showAddRecord();
    });

    // Mail Setup button
    $('dnsMailSetupBtn') && $('dnsMailSetupBtn').addEventListener('click', async () => {
      if (!activeZone) return;
      if (!confirm(`Set up mail for ${activeZone}?\n\nConfigures DNS (MX, SPF, DMARC, DKIM), autoconfig, webmail, mail/webmail/MTA-STS TLS certs, and Dovecot SNI. Safe to re-run.`)) return;
      $('dnsMailSetupBtn').disabled = true;
      const original = $('dnsMailSetupBtn').textContent;
      $('dnsMailSetupBtn').textContent = 'Setting up…';
      try {
        const res = await apiPost('/api/dns/zones/' + activeZone + '/mail-setup', {});
        await loadRecords(activeZone);
        const steps = res?.data?.steps || [];
        const ok = steps.filter(s => s.status === 'success').length;
        const failed = steps.filter(s => s.status === 'failed').length;
        if (failed === 0) {
          window.toast && window.toast('success', 'Mail configured', `${ok} steps applied for ${activeZone}`);
        } else {
          window.toast && window.toast('warning', 'Partial setup', `${failed} step(s) failed — re-run after DNS propagates, or check Mail → Health.`);
        }
      } catch (err) {
        window.toast ? window.toast('error', 'Error', err.message) : alert(err.message);
      } finally {
        $('dnsMailSetupBtn').disabled = false;
        $('dnsMailSetupBtn').textContent = original;
      }
    });

    // Delete Zone button
    $('dnsDeleteZoneBtn') && $('dnsDeleteZoneBtn').addEventListener('click', async () => {
      if (!activeZone) return;
      if (!confirm(`Delete zone for ${activeZone}?\n\nThis stops DNS for this domain immediately.`)) return;
      $('dnsDeleteZoneBtn').disabled = true;
      try {
        await apiDelete('/api/dns/zones/' + activeZone, {});
        activeZone = null;
        $('dnsNoZoneMsg') && ($('dnsNoZoneMsg').style.display = '');
        $('dnsRecordTable') && ($('dnsRecordTable').style.display = 'none');
        $('dnsAddRecordBtn') && ($('dnsAddRecordBtn').disabled = true);
        $('dnsMailSetupBtn') && ($('dnsMailSetupBtn').disabled = true);
        $('dnsDeleteZoneBtn') && ($('dnsDeleteZoneBtn').disabled = true);
        if ($('dnsActiveZoneLabel')) $('dnsActiveZoneLabel').textContent = '—';
        await loadZones();
        window.toast && window.toast('success', 'Zone deleted', '');
      } catch (err) {
        window.toast ? window.toast('error', 'Error', err.message) : alert(err.message);
        $('dnsDeleteZoneBtn').disabled = false;
      }
    });

    // Add Zone form
    const azForm = $('dnsAddZoneForm');
    if (azForm) {
      azForm.addEventListener('submit', async e => {
        e.preventDefault();
        const domain = ($('dnsNewDomain').value || '').trim().toLowerCase();
        const ip     = ($('dnsNewIp').value || '').trim() || nsInfo.serverIp;
        if (!domain) return;
        const btn = azForm.querySelector('[type="submit"]');
        btn.disabled = true; btn.textContent = 'Creating…';
        try {
          await apiPost('/api/dns/zones', { domain, ip });
          closeModal('dnsAddZoneModal');
          await loadZones();
          await selectZone(domain);
          window.toast && window.toast('success', 'Zone created', domain);
        } catch (err) {
          window.toast ? window.toast('error', 'Error', err.message) : alert(err.message);
        } finally {
          btn.disabled = false; btn.textContent = 'Create Zone';
        }
      });
    }

    // Add Zone modal backdrop/close
    const azModal = $('dnsAddZoneModal');
    if (azModal) {
      azModal.addEventListener('click', e => { if (e.target === azModal) closeModal('dnsAddZoneModal'); });
      azModal.querySelectorAll('.modal-close').forEach(b => b.addEventListener('click', () => closeModal('dnsAddZoneModal')));
    }

    // Record type change
    $('dnsRecType') && $('dnsRecType').addEventListener('change', updatePriorityRow);

    // Add Record form
    const arForm = $('dnsAddRecordForm');
    if (arForm) {
      arForm.addEventListener('submit', async e => {
        e.preventDefault();
        const name     = ($('dnsRecName').value || '').trim();
        const type     = $('dnsRecType').value;
        const ttl      = parseInt($('dnsRecTtl').value, 10) || 14400;
        const value    = ($('dnsRecValue').value || '').trim();
        const priority = parseInt($('dnsRecPriority').value, 10) || 10;
        if (!name || !value) return;
        const btn = arForm.querySelector('[type="submit"]');
        btn.disabled = true; btn.textContent = 'Adding…';
        try {
          const body = { name, type, ttl, value };
          if (type === 'MX' || type === 'SRV') body.priority = priority;
          await apiPost('/api/dns/zones/' + activeZone + '/records', body);
          closeModal('dnsAddRecordModal');
          await Promise.all([loadRecords(activeZone), loadZones()]);
          window.toast && window.toast('success', 'Record added', '');
        } catch (err) {
          window.toast ? window.toast('error', 'Error', err.message) : alert(err.message);
        } finally {
          btn.disabled = false; btn.textContent = 'Add Record';
        }
      });
    }

    // Add Record modal backdrop/close
    const arModal = $('dnsAddRecordModal');
    if (arModal) {
      arModal.addEventListener('click', e => { if (e.target === arModal) closeModal('dnsAddRecordModal'); });
      arModal.querySelectorAll('.modal-close').forEach(b => b.addEventListener('click', () => closeModal('dnsAddRecordModal')));
    }
  }

  // ── Public init (called by navigate) ───────────────────────────────────────
  async function init() {
    if (!initialized) {
      wireEvents();
      initialized = true;
    }
    // Reset record table to hidden if no active zone
    if (!activeZone) {
      $('dnsRecordTable') && ($('dnsRecordTable').style.display = 'none');
      $('dnsNoZoneMsg')   && ($('dnsNoZoneMsg').style.display   = '');
    }
    await Promise.all([loadNsInfo(), loadZones()]);
    // Re-select active zone if still valid
    if (activeZone) await selectZone(activeZone);
  }

  return { init };
})();
