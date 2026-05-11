// ── DAnalytics frontend module ────────────────────────────────────────────────
window.analyticsModule = (() => {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────────
  let domain         = 'all';
  let granularity    = 'daily';
  let trafficType    = 'real';
  let fromDate       = '';
  let toDate         = '';
  let tz             = 'America/Chicago';
  let geoLevel       = 'country';
  let geoFilter      = {};
  let geoCache       = null;
  let realtimeTimer  = null;
  let debounceTimer  = null;
  let timeChart      = null;
  let sourceChart    = null;
  let comparisonMode = false;
  let compPrevData   = null;
  let initialized    = false;
  let loading        = false;
  let activeTab      = 'overview'; // 'overview' | 'errors' | 'reports'
  let drilldownUrl   = null;

  // ── Design-system color tokens ─────────────────────────────────────────────
  const C = {
    blue:   '#4f8ef7',
    green:  '#3dd68c',
    amber:  '#f5a623',
    red:    '#f75f5f',
    purple: '#a78bfa',
    teal:   '#2dd4bf',
    pink:   '#f472b6',
    muted:  '#7a86a0',
    bgCard: '#1c2130',
    border: 'rgba(255,255,255,0.07)',
    text:   '#7a86a0',
  };

  const SOURCE_COLORS  = { 'Direct': C.blue, 'Organic Search': C.green, 'Social': C.amber, 'Referral': C.purple };
  const DEVICE_COLORS  = { 'Desktop': C.blue, 'Mobile': C.teal, 'Tablet': C.amber, 'Other': C.muted };
  const BROWSER_COLORS = { 'Chrome': C.blue, 'Firefox': C.amber, 'Safari': C.teal, 'Edge': C.purple, 'Opera': C.red, 'Samsung': C.pink, 'Other': C.muted, 'Chromium': C.muted, 'IE': C.muted, 'curl': C.muted };
  const OS_COLORS      = { 'Windows': C.blue, 'macOS': C.teal, 'Linux': C.amber, 'Android': C.green, 'iOS': C.purple, 'ChromeOS': C.muted, 'Other': C.muted };

  // Common IANA timezone labels for dropdown
  const TIMEZONES = [
    { value: 'America/New_York',    label: 'Eastern (ET)' },
    { value: 'America/Chicago',     label: 'Central (CT)' },
    { value: 'America/Denver',      label: 'Mountain (MT)' },
    { value: 'America/Phoenix',     label: 'Arizona (MT no DST)' },
    { value: 'America/Los_Angeles', label: 'Pacific (PT)' },
    { value: 'America/Anchorage',   label: 'Alaska (AKT)' },
    { value: 'Pacific/Honolulu',    label: 'Hawaii (HST)' },
    { value: 'Europe/London',       label: 'London (GMT/BST)' },
    { value: 'Europe/Paris',        label: 'Central Europe (CET)' },
    { value: 'Asia/Tokyo',          label: 'Tokyo (JST)' },
    { value: 'Asia/Shanghai',       label: 'China (CST)' },
    { value: 'Australia/Sydney',    label: 'Sydney (AEDT)' },
    { value: 'UTC',                 label: 'UTC' },
  ];

  // ── Country helpers ────────────────────────────────────────────────────────
  const COUNTRY_NAMES = {
    US:'United States', GB:'United Kingdom', CA:'Canada', AU:'Australia', DE:'Germany',
    FR:'France', NL:'Netherlands', IN:'India', BR:'Brazil', MX:'Mexico', JP:'Japan',
    CN:'China', RU:'Russia', KR:'South Korea', IT:'Italy', ES:'Spain', PL:'Poland',
    SE:'Sweden', NO:'Norway', DK:'Denmark', FI:'Finland', CH:'Switzerland', AT:'Austria',
    BE:'Belgium', PT:'Portugal', TR:'Turkey', IL:'Israel', SG:'Singapore', HK:'Hong Kong',
    NZ:'New Zealand', ZA:'South Africa', NG:'Nigeria', EG:'Egypt', SA:'Saudi Arabia',
    AE:'UAE', AR:'Argentina', CO:'Colombia', CL:'Chile', PH:'Philippines', ID:'Indonesia',
    MY:'Malaysia', TH:'Thailand', VN:'Vietnam', PK:'Pakistan', BD:'Bangladesh', UA:'Ukraine',
    RO:'Romania', HU:'Hungary', CZ:'Czech Republic', SK:'Slovakia', GR:'Greece', HR:'Croatia',
    BG:'Bulgaria', RS:'Serbia', LT:'Lithuania', LV:'Latvia', EE:'Estonia', IS:'Iceland',
    IE:'Ireland', LU:'Luxembourg', MT:'Malta', CY:'Cyprus', SI:'Slovenia', BA:'Bosnia',
    MK:'North Macedonia', AL:'Albania', ME:'Montenegro', MD:'Moldova', BY:'Belarus',
    KZ:'Kazakhstan', UZ:'Uzbekistan', GE:'Georgia', AM:'Armenia', AZ:'Azerbaijan',
    TW:'Taiwan', MO:'Macau', MM:'Myanmar', KH:'Cambodia', LA:'Laos', LK:'Sri Lanka',
    NP:'Nepal', AF:'Afghanistan', IQ:'Iraq', IR:'Iran', SY:'Syria', JO:'Jordan',
    LB:'Lebanon', KW:'Kuwait', QA:'Qatar', BH:'Bahrain', OM:'Oman', YE:'Yemen',
    TZ:'Tanzania', KE:'Kenya', GH:'Ghana', ET:'Ethiopia', SN:'Senegal', CI:"Côte d'Ivoire",
    CM:'Cameroon', MZ:'Mozambique', MG:'Madagascar', AO:'Angola', ZM:'Zambia', ZW:'Zimbabwe',
    UG:'Uganda', RW:'Rwanda', DZ:'Algeria', MA:'Morocco', TN:'Tunisia', LY:'Libya',
    PE:'Peru', VE:'Venezuela', EC:'Ecuador', BO:'Bolivia', PY:'Paraguay', UY:'Uruguay',
    GT:'Guatemala', CU:'Cuba', DO:'Dominican Republic', PR:'Puerto Rico', JM:'Jamaica',
    HT:'Haiti', PA:'Panama', CR:'Costa Rica', HN:'Honduras', SV:'El Salvador', NI:'Nicaragua',
    XX:'Unknown',
  };

  const US_STATES = {
    TX:'Texas',CA:'California',NY:'New York',FL:'Florida',IL:'Illinois',PA:'Pennsylvania',
    OH:'Ohio',GA:'Georgia',NC:'North Carolina',MI:'Michigan',WA:'Washington',AZ:'Arizona',
    MA:'Massachusetts',TN:'Tennessee',IN:'Indiana',MD:'Maryland',MO:'Missouri',WI:'Wisconsin',
    CO:'Colorado',MN:'Minnesota',SC:'South Carolina',AL:'Alabama',LA:'Louisiana',KY:'Kentucky',
    OR:'Oregon',OK:'Oklahoma',CT:'Connecticut',UT:'Utah',IA:'Iowa',NV:'Nevada',AR:'Arkansas',
    MS:'Mississippi',KS:'Kansas',NM:'New Mexico',NE:'Nebraska',WV:'West Virginia',ID:'Idaho',
    HI:'Hawaii',NH:'New Hampshire',ME:'Maine',RI:'Rhode Island',MT:'Montana',DE:'Delaware',
    SD:'South Dakota',ND:'North Dakota',AK:'Alaska',VT:'Vermont',WY:'Wyoming',DC:'D.C.',
    VA:'Virginia',NJ:'New Jersey',
  };

  function countryName(code) { return !code ? 'Unknown' : (COUNTRY_NAMES[code.toUpperCase()] || code.toUpperCase()); }
  function countryFlag(code) {
    if (!code || code.length !== 2) return '';
    const offset = 0x1F1E6 - 65;
    return String.fromCodePoint(code.toUpperCase().charCodeAt(0) + offset) +
           String.fromCodePoint(code.toUpperCase().charCodeAt(1) + offset);
  }

  // ── Shared Chart.js tooltip defaults ──────────────────────────────────────
  const TOOLTIP = {
    backgroundColor: '#0f1420',
    borderColor:     'rgba(255,255,255,0.12)',
    borderWidth:     1,
    titleColor:      '#e4e8f0',
    bodyColor:       '#a0aabb',
    padding:         14,
    cornerRadius:    10,
    displayColors:   false,
    titleFont:       { family: "'DM Sans',sans-serif", size: 12, weight: '600' },
    bodyFont:        { family: "'DM Sans',sans-serif", size: 12 },
  };

  // ── Init ───────────────────────────────────────────────────────────────────
  async function init() {
    if (initialized) { load(); return; }
    initialized = true;

    // Load user timezone preference from server
    try {
      const meResp = await api.get('/api/settings/me');
      if (meResp?.success && meResp.data?.timezone) {
        tz = meResp.data.timezone;
      }
    } catch (_) {
      tz = localStorage.getItem('analyticsTimezone') || 'America/Chicago';
    }

    // Populate timezone dropdown
    const tzSel = document.getElementById('analyticsTimezoneSelect');
    if (tzSel) {
      tzSel.innerHTML = TIMEZONES.map(t =>
        `<option value="${t.value}"${t.value === tz ? ' selected' : ''}>${t.label}</option>`
      ).join('') + `<option value="${tz}"${!TIMEZONES.find(t => t.value === tz) ? ' selected' : ''}>Custom: ${tz}</option>`;
      tzSel.addEventListener('change', async () => {
        tz = tzSel.value;
        localStorage.setItem('analyticsTimezone', tz);
        try { await api.patch('/api/settings/timezone', { timezone: tz }); } catch (_) {}
        load();
      });
    }

    setPreset(30);
    bindControlEvents();
    loadDomains();
    startRealtime();
    loadHealthStatus();
    load();
  }

  function bindControlEvents() {
    document.querySelectorAll('.analytics-preset').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.analytics-preset').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const days = btn.dataset.days;
        if (days === 'today') {
          const today = new Date().toLocaleDateString('en-CA', { timeZone: tz });
          fromDate = toDate = today;
          document.getElementById('analyticsFrom').value = today;
          document.getElementById('analyticsTo').value   = today;
          setGranularity('hourly');
        } else if (days === 'ytd') {
          const now = new Date();
          const year = now.toLocaleDateString('en-CA', { timeZone: tz, year: 'numeric' }).slice(0, 4);
          fromDate = `${year}-01-01`;
          toDate   = now.toLocaleDateString('en-CA', { timeZone: tz });
          document.getElementById('analyticsFrom').value = fromDate;
          document.getElementById('analyticsTo').value   = toDate;
          setGranularity('daily');
        } else {
          const n = parseInt(days, 10);
          setPreset(n);
          setGranularity(n <= 2 ? 'hourly' : n <= 90 ? 'daily' : 'weekly');
        }
        load();
      });
    });

    document.querySelectorAll('.analytics-traffic').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.analytics-traffic').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        trafficType = btn.dataset.type;
        load();
      });
    });

    document.querySelectorAll('.analytics-gran').forEach(btn => {
      btn.addEventListener('click', () => {
        setGranularity(btn.dataset.gran);
        load();
      });
    });

    const domainSel = document.getElementById('analyticsDomainsSelect');
    if (domainSel) domainSel.addEventListener('change', () => { domain = domainSel.value; load(); startRealtime(); });

    ['analyticsFrom', 'analyticsTo'].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('change', () => {
        fromDate = document.getElementById('analyticsFrom').value;
        toDate   = document.getElementById('analyticsTo').value;
        document.querySelectorAll('.analytics-preset').forEach(b => b.classList.remove('active'));
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(load, 450);
      });
    });

    // Tab buttons
    document.querySelectorAll('.analytics-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        switchTab(btn.dataset.tab);
      });
    });

    // Comparison mode toggle
    const compToggle = document.getElementById('analyticsCompareToggle');
    if (compToggle) {
      compToggle.addEventListener('change', () => {
        comparisonMode = compToggle.checked;
        load();
      });
    }
  }

  function setGranularity(gran) {
    granularity = gran;
    document.querySelectorAll('.analytics-gran').forEach(b => {
      b.classList.toggle('active', b.dataset.gran === gran);
    });
  }

  function setPreset(days) {
    const toD  = new Date();
    const from = new Date(toD.getTime() - days * 86400000);
    // Format in user's timezone
    fromDate = from.toLocaleDateString('en-CA', { timeZone: tz });
    toDate   = toD.toLocaleDateString('en-CA', { timeZone: tz });
    const fEl = document.getElementById('analyticsFrom');
    const tEl = document.getElementById('analyticsTo');
    if (fEl) fEl.value = fromDate;
    if (tEl) tEl.value = toDate;
  }

  function switchTab(tab) {
    activeTab = tab;
    document.querySelectorAll('.analytics-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.analytics-tab-content').forEach(el => {
      el.style.display = el.dataset.tab === tab ? '' : 'none';
    });
    if (tab === 'errors') loadErrors();
    if (tab === 'reports') loadReports();
  }

  async function loadDomains() {
    const data = await api.get('/api/analytics/domains');
    if (!data?.success) return;
    const sel = document.getElementById('analyticsDomainsSelect');
    if (!sel) return;
    while (sel.options.length > 1) sel.remove(1);
    data.data.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d; opt.textContent = d;
      sel.appendChild(opt);
    });
  }

  // ── Main data load ──────────────────────────────────────────────────────────
  async function load() {
    if (loading) return;
    loading = true;
    showSkeletons();

    const params = new URLSearchParams({ domain, from: fromDate, to: toDate, granularity, trafficType, tz });

    try {
      if (comparisonMode) {
        const [compResp, geoResp] = await Promise.all([
          api.get('/api/analytics/comparison?' + params),
          api.get('/api/analytics/geo?' + new URLSearchParams({ domain, from: fromDate, to: toDate, trafficType, tz })),
        ]);
        loading = false;
        if (!compResp?.success) { showErrorState(compResp?.error); return; }
        geoCache = geoResp?.success ? geoResp.data : null;
        compPrevData = compResp.data.previous;
        render(compResp.data.current, compResp.data.previous);
        renderGeo();
        loadTrafficBreakdown();
      } else {
        const [statsResp, geoResp] = await Promise.all([
          api.get('/api/analytics/stats?' + params),
          api.get('/api/analytics/geo?' + new URLSearchParams({ domain, from: fromDate, to: toDate, trafficType, tz })),
        ]);
        loading = false;
        if (!statsResp?.success) { showErrorState(statsResp?.error); return; }
        geoCache = geoResp?.success ? geoResp.data : null;
        compPrevData = null;
        render(statsResp.data, null);
        renderGeo();
        loadTrafficBreakdown();
      }
    } catch (err) {
      loading = false;
      showErrorState(err.message);
    }

    // Reload errors tab if active
    if (activeTab === 'errors') loadErrors();
  }

  // ── Traffic breakdown ───────────────────────────────────────────────────────
  async function loadTrafficBreakdown() {
    const el = document.getElementById('analyticsTrafficBreakdown');
    if (!el) return;

    const params = new URLSearchParams({ domain, from: fromDate, to: toDate, granularity: 'daily', trafficType: 'all', tz });
    const allData = await api.get('/api/analytics/stats?' + params);
    if (!allData?.success) { el.innerHTML = emptyState('No traffic classification data.'); return; }

    const allPV = allData.data?.summary?.pageviews || 0;

    const [realResp, botsResp] = await Promise.all([
      api.get('/api/analytics/stats?' + new URLSearchParams({ domain, from: fromDate, to: toDate, granularity: 'daily', trafficType: 'real', tz })),
      api.get('/api/analytics/stats?' + new URLSearchParams({ domain, from: fromDate, to: toDate, granularity: 'daily', trafficType: 'bots', tz })),
    ]);

    const realPV = realResp?.data?.summary?.pageviews || 0;
    const botPV  = botsResp?.data?.summary?.pageviews  || 0;

    if (allPV === 0) { el.innerHTML = emptyState('No traffic data in this range.'); return; }

    const rows = [
      { label: 'Real Users',      count: realPV, color: C.green, pct: pct(realPV, allPV) },
      { label: 'Bots & Scrapers', count: botPV,  color: C.red,   pct: pct(botPV,  allPV) },
    ];

    el.innerHTML = `
      <div class="a-class-grid">
        ${rows.map(r => `
          <div class="a-class-row">
            <div class="a-class-label">
              <span class="a-dot" style="background:${r.color}"></span>
              ${esc(r.label)}
            </div>
            <div class="a-bar-track" style="flex:1">
              <div class="a-bar-fill" style="width:${r.pct}%;background:${r.color};height:100%"></div>
            </div>
            <div class="a-class-meta">
              <span style="color:${r.color};font-weight:600">${r.pct}%</span>
              <span style="color:var(--text-muted)">${fmtNum(r.count)}</span>
            </div>
          </div>`).join('')}
      </div>
      <p style="font-size:.72rem;color:var(--text-muted);margin-top:12px">
        ${fmtNum(allPV)} total requests · Real user rate: <strong style="color:${C.green}">${pct(realPV, allPV)}%</strong>
      </p>`;
  }

  // ── Errors tab ──────────────────────────────────────────────────────────────
  async function loadErrors() {
    const el = document.getElementById('analyticsErrorsContent');
    if (!el) return;
    el.innerHTML = `<div class="skeleton" style="height:200px;border-radius:var(--radius-md)"></div>`;

    const params = new URLSearchParams({ domain, from: fromDate, to: toDate, tz });
    const resp = await api.get('/api/analytics/errors?' + params);
    if (!resp?.success) { el.innerHTML = emptyState('Failed to load error data.'); return; }

    const { statusBreakdown, topErrorUrls, errorRate, errorRequests, totalRequests } = resp.data;

    if (!errorRequests) {
      el.innerHTML = `<div class="empty-state" style="padding:var(--space-6)">
        <p class="text-sm" style="color:${C.green}">✓ No HTTP errors in this date range.</p>
      </div>`;
      return;
    }

    const statusColors = { 404: C.amber, 403: C.red, 500: C.red, 503: C.red };
    const getStatusColor = s => {
      if (s >= 500) return C.red;
      if (s >= 400) return C.amber;
      return C.muted;
    };

    el.innerHTML = `
      <div style="display:flex;align-items:center;gap:16px;margin-bottom:var(--space-4)">
        <div class="card-outer" style="flex:0 0 auto;padding:0">
          <div class="card-inner" style="padding:16px 20px;text-align:center">
            <div style="font-size:1.75rem;font-weight:700;color:${errorRate > 5 ? C.red : C.amber};letter-spacing:-0.04em">${errorRate}%</div>
            <div style="font-size:.75rem;color:var(--text-muted)">Error Rate</div>
          </div>
        </div>
        <div class="card-outer" style="flex:0 0 auto;padding:0">
          <div class="card-inner" style="padding:16px 20px;text-align:center">
            <div style="font-size:1.75rem;font-weight:700;color:${C.amber};letter-spacing:-0.04em">${fmtNum(errorRequests)}</div>
            <div style="font-size:.75rem;color:var(--text-muted)">Error Requests</div>
          </div>
        </div>
      </div>

      <div class="a-grid-2">
        <!-- Status codes -->
        <div class="card-outer"><div class="card-inner">
          <h4 style="margin-bottom:var(--space-3)">By Status Code</h4>
          ${statusBreakdown.slice(0, 10).map(r => `
            <div class="a-bar-row" style="grid-template-columns:52px 1fr 80px 52px">
              <div style="font-family:var(--font-mono);font-size:.8rem;font-weight:600;color:${getStatusColor(r.status)}">${r.status}</div>
              <div class="a-bar-track">
                <div class="a-bar-fill" style="width:${pct(r.count, statusBreakdown[0].count)}%;background:${getStatusColor(r.status)}"></div>
              </div>
              <div class="a-bar-pct">${pct(r.count, errorRequests)}%</div>
              <div class="a-bar-count">${fmtNum(r.count)}</div>
            </div>`).join('')}
        </div></div>

        <!-- Top error URLs -->
        <div class="card-outer"><div class="card-inner">
          <h4 style="margin-bottom:var(--space-3)">Top Error URLs</h4>
          ${topErrorUrls.slice(0, 10).map((r, i) => `
            <div class="a-bar-row">
              <div class="a-bar-rank">${i + 1}</div>
              <div class="a-bar-label" title="${esc(r.url)}" style="display:flex;align-items:center;gap:6px">
                <span class="badge" style="font-size:.62rem;padding:1px 5px;background:${getStatusColor(r.status)}22;color:${getStatusColor(r.status)}">${r.status}</span>
                ${esc(fmtUrl(r.url))}
              </div>
              <div class="a-bar-track"><div class="a-bar-fill" style="width:${pct(r.count, topErrorUrls[0]?.count || 1)}%;background:${getStatusColor(r.status)}"></div></div>
              <div class="a-bar-pct">${pct(r.count, errorRequests)}%</div>
              <div class="a-bar-count">${fmtNum(r.count)}</div>
            </div>`).join('')}
        </div></div>
      </div>`;
  }

  // ── Ingestion health status ─────────────────────────────────────────────────
  async function loadHealthStatus() {
    const el = document.getElementById('analyticsHealthStatus');
    if (!el) return;

    const resp = await api.get('/api/analytics/health');
    if (!resp?.success) { el.innerHTML = ''; return; }

    const { lastCursorUpdate, domains } = resp.data;
    if (!lastCursorUpdate) { el.innerHTML = ''; return; }

    const lastUpdate = new Date(lastCursorUpdate);
    const minutesAgo = Math.round((Date.now() - lastUpdate.getTime()) / 60000);
    const isStale    = minutesAgo > 5;
    const color      = isStale ? C.amber : C.green;

    el.innerHTML = `
      <span title="Last log ingestion: ${lastUpdate.toLocaleString()}"
            style="font-size:.72rem;color:${color};display:inline-flex;align-items:center;gap:5px">
        <span style="width:6px;height:6px;border-radius:50%;background:${color};display:inline-block"></span>
        ${isStale ? `Stale — last updated ${minutesAgo}m ago` : `Live — updated ${minutesAgo < 1 ? '< 1' : minutesAgo}m ago`}
      </span>`;
  }

  // ── Reports tab ─────────────────────────────────────────────────────────────
  async function loadReports() {
    const el = document.getElementById('analyticsReportsContent');
    if (!el) return;

    const resp = await api.get('/api/analytics/reports');
    if (!resp?.success) { el.innerHTML = emptyState('Failed to load reports.'); return; }

    const subs = resp.data;

    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--space-4)">
        <div>
          <h4 style="margin:0 0 4px">Email Report Subscriptions</h4>
          <p style="font-size:.75rem;color:var(--text-muted)">Automated analytics digests delivered to any email address</p>
        </div>
        <button class="btn btn-primary btn-sm" onclick="window.analyticsModule.openNewReportModal()">
          + New Subscription
        </button>
      </div>

      ${subs.length === 0 ? emptyState('No report subscriptions yet. Create one to start receiving email digests.') : `
        <div style="display:flex;flex-direction:column;gap:10px">
          ${subs.map(sub => `
            <div class="card-outer" style="padding:0">
              <div class="card-inner" style="padding:14px 16px;display:flex;align-items:center;gap:14px;flex-wrap:wrap">
                <div style="flex:1;min-width:200px">
                  <div style="font-weight:600;color:var(--text-primary);margin-bottom:3px">${esc(sub.label)}</div>
                  <div style="font-size:.75rem;color:var(--text-muted)">
                    To: <span style="color:var(--text-secondary)">${esc(sub.recipient_email)}</span>
                    &nbsp;·&nbsp;
                    <span style="text-transform:capitalize">${sub.frequency}</span>
                    &nbsp;·&nbsp;
                    Domains: <span style="font-family:var(--font-mono)">${sub.domains.includes('*') ? 'All' : sub.domains.join(', ')}</span>
                  </div>
                  ${sub.last_sent ? `<div style="font-size:.7rem;color:var(--text-muted);margin-top:2px">Last sent: ${new Date(sub.last_sent).toLocaleString()}</div>` : ''}
                </div>
                <div style="display:flex;align-items:center;gap:8px">
                  <span class="badge ${sub.active ? 'badge-green' : ''}" style="${!sub.active ? 'background:rgba(255,255,255,.06);color:var(--text-muted)' : ''}">
                    ${sub.active ? 'Active' : 'Paused'}
                  </span>
                  <button class="btn btn-xs btn-ghost" onclick="window.analyticsModule.sendReportNow(${sub.id})" title="Send now">
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2L2 8l5 2 2 5 5-13z"/></svg>
                    Send Now
                  </button>
                  <button class="btn btn-xs btn-ghost" onclick="window.analyticsModule.toggleReport(${sub.id}, ${sub.active})" title="${sub.active ? 'Pause' : 'Resume'}">
                    ${sub.active ? 'Pause' : 'Resume'}
                  </button>
                  <button class="btn btn-xs btn-ghost" style="color:${C.red}" onclick="window.analyticsModule.deleteReport(${sub.id})" title="Delete">
                    Delete
                  </button>
                </div>
              </div>
            </div>`).join('')}
        </div>
      `}`;
  }

  function openNewReportModal() {
    const modal = document.getElementById('modalNewReport');
    if (modal) modal.classList.add('open');
  }

  async function saveNewReport() {
    const label    = document.getElementById('newReportLabel')?.value.trim();
    const email    = document.getElementById('newReportEmail')?.value.trim();
    const freq     = document.getElementById('newReportFreq')?.value || 'weekly';
    const domainEl = document.getElementById('newReportDomains')?.value.trim();

    if (!label || !email) { toast('error', 'Label and email are required'); return; }

    let domains = ['*'];
    if (domainEl && domainEl !== '*' && domainEl !== '') {
      domains = domainEl.split(',').map(d => d.trim()).filter(Boolean);
    }

    const resp = await api.post('/api/analytics/reports', { label, recipient_email: email, frequency: freq, domains });
    if (resp?.success) {
      toast('success', 'Report subscription created');
      document.getElementById('modalNewReport')?.classList.remove('open');
      loadReports();
    } else {
      toast('error', resp?.error || 'Failed to create subscription');
    }
  }

  async function sendReportNow(id) {
    toast('info', 'Sending report...');
    const resp = await api.post(`/api/analytics/reports/${id}/send`, {});
    if (resp?.success) toast('success', 'Report sent successfully');
    else toast('error', resp?.error || 'Failed to send report');
  }

  async function toggleReport(id, currentActive) {
    const resp = await api.put(`/api/analytics/reports/${id}`, { active: currentActive ? 0 : 1 });
    if (resp?.success) loadReports();
    else toast('error', resp?.error || 'Failed to update');
  }

  async function deleteReport(id) {
    if (!confirm('Delete this report subscription?')) return;
    const resp = await api.delete(`/api/analytics/reports/${id}`);
    if (resp?.success) { toast('success', 'Deleted'); loadReports(); }
    else toast('error', resp?.error || 'Failed to delete');
  }

  // ── Master render ───────────────────────────────────────────────────────────
  function render(d, prev) {
    renderSummaryCards(d.summary, prev?.summary);
    renderTimeSeries(d.timeSeries, d.summary, prev?.timeSeries);
    renderTopPages(d.topPages);
    renderSources(d.sources);
    renderBreakdown('analyticsDevices',  d.devices,          DEVICE_COLORS);
    renderBreakdown('analyticsBrowsers', d.browsers,         BROWSER_COLORS);
    renderBreakdown('analyticsOS',       d.operatingSystems, OS_COLORS);
    renderReferrers(d.referrers);

    // Show data source badge
    const badge = document.getElementById('analyticsDataSource');
    if (badge) {
      if (d.fromRollup) {
        badge.innerHTML = `<span style="font-size:.7rem;color:${C.teal};opacity:.7">rollup data</span>`;
      } else if (d.fromDB) {
        badge.innerHTML = '';
      } else {
        badge.innerHTML = `<span style="font-size:.7rem;color:${C.amber};opacity:.7">log fallback</span>`;
      }
    }
  }

  // ── Summary cards ───────────────────────────────────────────────────────────
  function renderSummaryCards(s, prev) {
    const el = document.getElementById('analyticsStats');
    if (!el) return;

    const typeBadge = {
      real: `<span class="a-type-badge" style="background:${C.green}22;color:${C.green}">Real Users</span>`,
      bots: `<span class="a-type-badge" style="background:${C.red}22;color:${C.red}">Bots</span>`,
      all:  `<span class="a-type-badge" style="background:rgba(255,255,255,.08);color:var(--text-muted)">All Traffic</span>`,
    }[trafficType] || '';

    function delta(cur, p) {
      if (!p || !comparisonMode) return '';
      const d = cur - p;
      const pct = p > 0 ? Math.round((d / p) * 100) : 0;
      const color = d >= 0 ? C.green : C.red;
      const arrow = d >= 0 ? '▲' : '▼';
      return `<div style="font-size:.7rem;color:${color};margin-top:4px">${arrow} ${Math.abs(pct)}% vs prev period</div>`;
    }

    const cards = [
      { label: 'Page Views',      value: fmtNum(s.pageviews),           sub: 'total requests',            color: C.blue,                                       icon: iconEye(),     badge: typeBadge, delta: delta(s.pageviews, prev?.pageviews) },
      { label: 'Unique Visitors', value: fmtNum(s.uniqueVisitors),      sub: 'distinct fingerprints',      color: C.green,                                      icon: iconUsers(),   badge: '',        delta: delta(s.uniqueVisitors, prev?.uniqueVisitors) },
      { label: 'Sessions',        value: fmtNum(s.sessions),            sub: '30-min idle = new session',  color: C.amber,                                      icon: iconZap(),     badge: '',        delta: delta(s.sessions, prev?.sessions) },
      { label: 'Bounce Rate',     value: s.bounceRate + '%',            sub: 'single-page sessions',       color: s.bounceRate > 70 ? C.red : C.muted,          icon: iconPercent(), badge: '',        delta: delta(prev?.bounceRate, s.bounceRate) },
      { label: 'Avg Duration',    value: fmtDuration(s.avgDurationSec), sub: 'engaged sessions only',      color: C.teal,                                       icon: iconClock(),   badge: '',        delta: delta(s.avgDurationSec, prev?.avgDurationSec) },
    ];

    el.innerHTML = cards.map(c => `
      <div class="card-outer stat-card">
        <div class="card-inner">
          <div class="a-stat-header">
            <span class="a-stat-icon" style="background:${c.color}1a;color:${c.color}">${c.icon}</span>
            ${c.badge}
          </div>
          <div class="a-stat-value">${c.value}</div>
          <div class="a-stat-label">${c.label}</div>
          <div class="a-stat-sub">${c.sub}</div>
          ${c.delta}
        </div>
      </div>
    `).join('');
  }

  // ── Time-series area chart (with optional comparison line) ──────────────────
  function renderTimeSeries(series, summary, prevSeries) {
    const canvas = document.getElementById('analyticsTimeChart');
    if (!canvas) return;
    if (timeChart) { timeChart.destroy(); timeChart = null; }

    const nonZeroSeries = series.filter((p, i, arr) => {
      if (p.count > 0) return true;
      const hasDataBefore = arr.slice(0, i).some(x => x.count > 0);
      const hasDataAfter  = arr.slice(i + 1).some(x => x.count > 0);
      return hasDataBefore && hasDataAfter;
    });
    const displaySeries = nonZeroSeries.length > 1 ? nonZeroSeries : series;

    const chartColor = { bots: C.red, all: C.purple }[trafficType] || C.blue;
    const labels = displaySeries.map(p => fmtDateLabel(p.date));
    const counts = displaySeries.map(p => p.count);
    const maxVal = Math.max(...counts, 1);
    const totalPV = summary?.pageviews || counts.reduce((a, b) => a + b, 0);

    const ctx  = canvas.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 0, canvas.parentElement.offsetHeight || 300);
    grad.addColorStop(0,   hexAlpha(chartColor, 0.30));
    grad.addColorStop(0.6, hexAlpha(chartColor, 0.08));
    grad.addColorStop(1,   hexAlpha(chartColor, 0.00));

    const totalEl = document.getElementById('analyticsChartTotal');
    if (totalEl) totalEl.textContent = `${fmtNum(totalPV)} page views${comparisonMode ? ' (current period)' : ''}`;

    const datasets = [{
      label:               'Page Views',
      data:                counts,
      borderColor:         chartColor,
      backgroundColor:     grad,
      borderWidth:         2.5,
      pointRadius:         counts.length > 48 ? 0 : counts.length > 14 ? 2 : 4,
      pointHoverRadius:    6,
      pointBackgroundColor: chartColor,
      pointBorderColor:    '#141820',
      pointBorderWidth:    2,
      fill:                true,
      tension:             0.4,
      spanGaps:            true,
    }];

    // Add previous period line when in comparison mode
    if (comparisonMode && prevSeries && prevSeries.length) {
      const prevCounts = prevSeries.slice(0, displaySeries.length).map(p => p.count);
      datasets.push({
        label:               'Previous Period',
        data:                prevCounts,
        borderColor:         C.muted,
        backgroundColor:     'transparent',
        borderWidth:         1.5,
        borderDash:          [4, 4],
        pointRadius:         0,
        pointHoverRadius:    4,
        fill:                false,
        tension:             0.4,
        spanGaps:            true,
      });
    }

    timeChart = new Chart(canvas, {
      type: 'line',
      data: { labels, datasets },
      options: {
        responsive:          true,
        maintainAspectRatio: false,
        interaction:         { mode: 'index', intersect: false },
        animation:           { duration: 500, easing: 'easeOutQuart' },
        plugins: {
          legend: { display: comparisonMode, labels: { color: C.text, font: { family: "'DM Sans',sans-serif", size: 11 } } },
          tooltip: {
            ...TOOLTIP,
            callbacks: {
              title: items => {
                const iso = displaySeries[items[0].dataIndex]?.date;
                if (!iso) return items[0].label;
                const d = new Date(iso);
                if (granularity === 'hourly') {
                  return d.toLocaleString('en-US', { weekday:'short', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit', hour12:true, timeZone:'UTC' });
                }
                return d.toLocaleDateString('en-US', { weekday:'short', month:'long', day:'numeric', year:'numeric', timeZone:'UTC' });
              },
              label: item => `  ${item.dataset.label}: ${fmtNum(item.raw)} page views`,
            },
          },
        },
        scales: {
          x: {
            grid:   { color: 'rgba(255,255,255,0.035)', drawBorder: false },
            ticks:  { color: C.text, font: { family: "'DM Sans',sans-serif", size: 11 }, maxTicksLimit: granularity === 'hourly' ? 12 : 10, maxRotation: 0 },
            border: { display: false },
          },
          y: {
            grid:   { color: 'rgba(255,255,255,0.035)', drawBorder: false },
            ticks:  { color: C.text, font: { family: "'DM Sans',sans-serif", size: 11 }, callback: v => Number.isInteger(v) ? fmtNum(v) : '', precision: 0, maxTicksLimit: 6 },
            border:      { display: false },
            beginAtZero: true,
            suggestedMax: Math.max(maxVal * 1.15, 5),
          },
        },
      },
    });
  }

  // ── Top pages (with drill-down click) ──────────────────────────────────────
  function renderTopPages(pages) {
    const el = document.getElementById('analyticsTopPages');
    if (!el) return;
    if (!pages?.length) { el.innerHTML = emptyState('No page data for this range.'); return; }
    const max = pages[0].count;
    const total = pages.reduce((s, p) => s + p.count, 0);
    el.innerHTML = pages.slice(0, 12).map((p, i) => `
      <div class="a-bar-row" style="cursor:pointer" title="Drill into ${esc(p.name)}"
           onclick="window.analyticsModule.openPageDrilldown('${esc(p.name).replace(/'/g, "\\'")}')">
        <div class="a-bar-rank">${i + 1}</div>
        <div class="a-bar-label" title="${esc(p.name)}">${esc(fmtUrl(p.name))}</div>
        <div class="a-bar-track">
          <div class="a-bar-fill" style="width:${pct(p.count, max)}%;background:${C.blue}"></div>
        </div>
        <div class="a-bar-pct">${pct(p.count, total)}%</div>
        <div class="a-bar-count">${fmtNum(p.count)}</div>
      </div>`).join('');
  }

  // ── Page drill-down ─────────────────────────────────────────────────────────
  async function openPageDrilldown(url) {
    drilldownUrl = url;
    const modal = document.getElementById('modalPageDrilldown');
    if (!modal) return;
    modal.classList.add('open');

    const titleEl = document.getElementById('drilldownTitle');
    const bodyEl  = document.getElementById('drilldownBody');
    if (titleEl) titleEl.textContent = url;
    if (bodyEl)  bodyEl.innerHTML = `<div class="skeleton" style="height:180px;border-radius:var(--radius-md)"></div>`;

    const params = new URLSearchParams({ domain, url, from: fromDate, to: toDate, tz });
    const resp = await api.get('/api/analytics/page-drilldown?' + params);
    if (!resp?.success || !bodyEl) return;

    const d  = resp.data;
    const maxCount = Math.max(...d.timeSeries.map(p => p.count), 1);

    bodyEl.innerHTML = `
      <div style="display:flex;gap:16px;margin-bottom:16px;flex-wrap:wrap">
        <div style="background:rgba(255,255,255,.04);border-radius:8px;padding:12px 18px;text-align:center">
          <div style="font-size:1.5rem;font-weight:700;color:#e4e8f0">${fmtNum(d.totalPageviews)}</div>
          <div style="font-size:.72rem;color:var(--text-muted)">Page Views</div>
        </div>
        <div style="background:rgba(255,255,255,.04);border-radius:8px;padding:12px 18px;text-align:center">
          <div style="font-size:1.5rem;font-weight:700;color:#e4e8f0">${fmtNum(d.uniqueVisitors)}</div>
          <div style="font-size:.72rem;color:var(--text-muted)">Unique Visitors</div>
        </div>
      </div>

      <div style="position:relative;height:160px;margin-bottom:16px">
        <canvas id="drilldownChart"></canvas>
      </div>

      ${d.topReferrers.length ? `
        <h5 style="margin-bottom:8px;font-size:.875rem">Top Referrers for This Page</h5>
        ${d.topReferrers.map((r, i) => `
          <div class="a-bar-row">
            <div class="a-bar-rank">${i + 1}</div>
            <div class="a-bar-label">${esc(r.name || 'Direct')}</div>
            <div class="a-bar-track"><div class="a-bar-fill" style="width:${pct(r.count, d.topReferrers[0].count)}%;background:${C.purple}"></div></div>
            <div class="a-bar-count">${fmtNum(r.count)}</div>
          </div>`).join('')}` : ''}`;

    // Draw hourly chart
    const ddCanvas = document.getElementById('drilldownChart');
    if (ddCanvas) {
      new Chart(ddCanvas, {
        type: 'bar',
        data: {
          labels:   d.timeSeries.map(p => fmtDateLabel(p.date)),
          datasets: [{ data: d.timeSeries.map(p => p.count), backgroundColor: hexAlpha(C.blue, 0.5), borderColor: C.blue, borderWidth: 1, borderRadius: 4 }],
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false }, tooltip: { ...TOOLTIP, callbacks: { label: item => `  ${fmtNum(item.raw)} views` } } },
          scales: {
            x: { grid: { display: false }, ticks: { color: C.text, font: { size: 10 }, maxTicksLimit: 12, maxRotation: 0 }, border: { display: false } },
            y: { grid: { color: 'rgba(255,255,255,.03)' }, ticks: { color: C.text, font: { size: 10 }, precision: 0 }, border: { display: false }, beginAtZero: true },
          },
        },
      });
    }
  }

  // ── Traffic sources ─────────────────────────────────────────────────────────
  function renderSources(sources) {
    if (sourceChart) { sourceChart.destroy(); sourceChart = null; }
    const canvas = document.getElementById('analyticsSourceChart');

    if (!sources?.length) {
      const listEl = document.getElementById('analyticsSourceList');
      if (listEl) listEl.innerHTML = emptyState('No source data.');
      return;
    }

    const labels = sources.map(s => s.name);
    const counts = sources.map(s => s.count);
    const colors = sources.map(s => SOURCE_COLORS[s.name] || C.muted);
    const total  = counts.reduce((a, b) => a + b, 0);

    if (canvas) {
      sourceChart = new Chart(canvas, {
        type: 'doughnut',
        data: { labels, datasets: [{ data: counts, backgroundColor: colors, borderColor: '#141820', borderWidth: 3, hoverOffset: 8 }] },
        options: {
          responsive: true, maintainAspectRatio: false, cutout: '68%', animation: { duration: 500 },
          plugins: {
            legend: { display: false },
            tooltip: { ...TOOLTIP, displayColors: true, callbacks: { label: item => `  ${item.label}: ${fmtNum(item.raw)} (${pct(item.raw, total)}%)` } },
          },
        },
        plugins: [{
          id: 'centerText',
          afterDraw(chart) {
            const { ctx, chartArea: { top, bottom, left, right } } = chart;
            const cx = (left + right) / 2, cy = (top + bottom) / 2;
            ctx.save();
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillStyle = '#e4e8f0'; ctx.font = "600 1.4rem 'DM Sans',sans-serif";
            ctx.fillText(fmtNum(total), cx, cy - 8);
            ctx.fillStyle = '#7a86a0'; ctx.font = "400 0.7rem 'DM Sans',sans-serif";
            ctx.fillText('total visits', cx, cy + 12);
            ctx.restore();
          },
        }],
      });
    }

    const listEl = document.getElementById('analyticsSourceList');
    if (listEl) {
      listEl.innerHTML = sources.map((s, i) => `
        <div class="a-src-row">
          <div class="a-src-left">
            <span class="a-dot" style="background:${colors[i]}"></span>
            <span class="a-src-name">${esc(s.name)}</span>
          </div>
          <div class="a-src-bar">
            <div class="a-bar-fill" style="width:${pct(s.count, total)}%;background:${colors[i]};height:100%;border-radius:4px"></div>
          </div>
          <div class="a-src-meta">
            <span class="a-src-pct">${pct(s.count, total)}%</span>
            <span class="a-src-count">${fmtNum(s.count)}</span>
          </div>
        </div>`).join('');
    }
  }

  // ── Generic breakdown bars ──────────────────────────────────────────────────
  function renderBreakdown(containerId, items, colorMap) {
    const el = document.getElementById(containerId);
    if (!el) return;
    if (!items?.length) { el.innerHTML = emptyState('No data for this range.'); return; }
    const max   = items[0].count;
    const total = items.reduce((s, i) => s + i.count, 0);
    el.innerHTML = items.slice(0, 8).map(item => `
      <div class="a-bar-row" style="grid-template-columns:16px 1fr 90px 38px 48px">
        <div class="a-bar-dot" style="background:${colorMap[item.name] || C.muted};width:8px;height:8px;border-radius:50%"></div>
        <div class="a-bar-label">${esc(item.name)}</div>
        <div class="a-bar-track"><div class="a-bar-fill" style="width:${pct(item.count, max)}%;background:${colorMap[item.name] || C.muted}"></div></div>
        <div class="a-bar-pct">${pct(item.count, total)}%</div>
        <div class="a-bar-count">${fmtNum(item.count)}</div>
      </div>`).join('');
  }

  // ── Referrers table ─────────────────────────────────────────────────────────
  function renderReferrers(referrers) {
    const el = document.getElementById('analyticsReferrers');
    if (!el) return;
    if (!referrers?.length) {
      el.innerHTML = '<p class="text-sm text-muted" style="padding:var(--space-3) 0">No external referrers in this date range.</p>';
      return;
    }
    const max   = referrers[0].count;
    const total = referrers.reduce((s, r) => s + r.count, 0);
    el.innerHTML = referrers.map((r, i) => `
      <div class="a-bar-row">
        <div class="a-bar-rank">${i + 1}</div>
        <div class="a-bar-label">
          <a href="https://${esc(r.name)}" target="_blank" rel="noopener noreferrer"
             style="color:var(--accent);text-decoration:none;font-family:var(--font-mono);font-size:.8rem"
             onmouseover="this.style.textDecoration='underline'" onmouseout="this.style.textDecoration='none'"
          >${esc(r.name)}</a>
        </div>
        <div class="a-bar-track"><div class="a-bar-fill" style="width:${pct(r.count, max)}%;background:${C.purple}"></div></div>
        <div class="a-bar-pct">${pct(r.count, total)}%</div>
        <div class="a-bar-count">${fmtNum(r.count)}</div>
      </div>`).join('');
  }

  // ── Geographic breakdown ────────────────────────────────────────────────────
  function renderGeo() {
    const el = document.getElementById('analyticsGeo');
    if (!el) return;
    if (!geoCache) { el.innerHTML = emptyState('Geographic data not available yet.'); return; }
    if (geoLevel === 'country')     renderGeoCountries(el);
    else if (geoLevel === 'region') renderGeoRegions(el);
    else                            renderGeoCities(el);
    const backBtn = document.getElementById('geoBackBtn');
    if (backBtn) backBtn.style.display = geoLevel !== 'country' ? '' : 'none';
  }

  function renderGeoCountries(el) {
    const countries = geoCache?.countries || [];
    if (!countries.length) { el.innerHTML = emptyState('No geographic data for this range.'); return; }
    const max = countries[0].count, total = countries.reduce((s, r) => s + r.count, 0);
    el.innerHTML = countries.slice(0, 20).map((r, i) => `
      <div class="a-bar-row a-geo-row" tabindex="0" role="button"
           title="Drill into ${countryName(r.code)} regions"
           onclick="window.analyticsModule.geoDrill('country','${esc(r.code)}')"
           onkeydown="if(event.key==='Enter')window.analyticsModule.geoDrill('country','${esc(r.code)}')">
        <div class="a-bar-rank">${i + 1}</div>
        <div class="a-bar-label" style="display:flex;align-items:center;gap:8px">
          <span style="font-size:1.15em;line-height:1">${countryFlag(r.code)}</span>
          <span>${esc(countryName(r.code))}</span>
        </div>
        <div class="a-bar-track"><div class="a-bar-fill" style="width:${pct(r.count, max)}%;background:${C.blue}"></div></div>
        <div class="a-bar-pct">${pct(r.count, total)}%</div>
        <div class="a-bar-count">${fmtNum(r.count)}</div>
      </div>`).join('') + `<p style="font-size:.72rem;color:var(--text-muted);margin-top:10px">Click a country to drill into regions</p>`;
  }

  function renderGeoRegions(el) {
    const regions = (geoCache?.regions || []).filter(r => r.country === geoFilter.country);
    if (!regions.length) { el.innerHTML = emptyState(`No region data for ${countryName(geoFilter.country)}.`); return; }
    const max = regions[0].count, total = regions.reduce((s, r) => s + r.count, 0);
    el.innerHTML = `<p style="font-size:.8rem;color:var(--text-muted);margin-bottom:10px">
      ${countryFlag(geoFilter.country)} ${esc(countryName(geoFilter.country))} · Regions</p>
    ${regions.slice(0, 25).map((r, i) => {
      const label = (geoFilter.country === 'US' && US_STATES[r.region]) ? US_STATES[r.region] : (r.region || 'Unknown');
      return `<div class="a-bar-row a-geo-row" tabindex="0" role="button"
           onclick="window.analyticsModule.geoDrill('region','${esc(r.region)}')"
           onkeydown="if(event.key==='Enter')window.analyticsModule.geoDrill('region','${esc(r.region)}')">
        <div class="a-bar-rank">${i + 1}</div>
        <div class="a-bar-label">${esc(label)}</div>
        <div class="a-bar-track"><div class="a-bar-fill" style="width:${pct(r.count, max)}%;background:${C.teal}"></div></div>
        <div class="a-bar-pct">${pct(r.count, total)}%</div>
        <div class="a-bar-count">${fmtNum(r.count)}</div>
      </div>`;
    }).join('')}
    <p style="font-size:.72rem;color:var(--text-muted);margin-top:10px">Click a region to see cities</p>`;
  }

  function renderGeoCities(el) {
    const cities = (geoCache?.cities || []).filter(r => r.country === geoFilter.country && r.region === geoFilter.region);
    if (!cities.length) { el.innerHTML = emptyState(`No city data for this region.`); return; }
    const max = cities[0].count, total = cities.reduce((s, r) => s + r.count, 0);
    const regionLabel = (geoFilter.country === 'US' && US_STATES[geoFilter.region]) ? US_STATES[geoFilter.region] : geoFilter.region;
    el.innerHTML = `<p style="font-size:.8rem;color:var(--text-muted);margin-bottom:10px">
      ${countryFlag(geoFilter.country)} ${esc(countryName(geoFilter.country))} › ${esc(regionLabel)} · Cities</p>
    ${cities.slice(0, 25).map((r, i) => `
      <div class="a-bar-row">
        <div class="a-bar-rank">${i + 1}</div>
        <div class="a-bar-label">${esc(r.city || 'Unknown')}</div>
        <div class="a-bar-track"><div class="a-bar-fill" style="width:${pct(r.count, max)}%;background:${C.purple}"></div></div>
        <div class="a-bar-pct">${pct(r.count, total)}%</div>
        <div class="a-bar-count">${fmtNum(r.count)}</div>
      </div>`).join('')}`;
  }

  function geoDrill(level, value) {
    if (level === 'country') { geoFilter = { country: value }; geoLevel = 'region'; }
    else if (level === 'region') { geoFilter.region = value; geoLevel = 'city'; }
    renderGeo();
  }

  function geoDrillBack() {
    if (geoLevel === 'city') { geoLevel = 'region'; delete geoFilter.region; }
    else { geoLevel = 'country'; geoFilter = {}; }
    renderGeo();
  }

  // ── Real-time badge ─────────────────────────────────────────────────────────
  function startRealtime() {
    pollRealtime();
    clearInterval(realtimeTimer);
    realtimeTimer = setInterval(pollRealtime, 60000);
  }

  async function pollRealtime() {
    const el      = document.getElementById('analyticsRealtime');
    const countEl = document.getElementById('analyticsRealtimeCount');
    if (!el || !countEl) return;
    const data = await api.get(`/api/analytics/realtime?domain=${encodeURIComponent(domain)}`);
    if (!data?.success) return;
    const n = data.data.activeVisitors || 0;
    countEl.textContent = n;
    el.style.display = n > 0 ? '' : 'none';
  }

  // ── CSV export ──────────────────────────────────────────────────────────────
  function exportCSV() {
    const params = new URLSearchParams({ domain, from: fromDate, to: toDate, granularity, trafficType, tz });
    window.location.href = '/api/analytics/export/csv?' + params;
  }

  // ── PDF export ──────────────────────────────────────────────────────────────
  function exportPDF() {
    const d = document.getElementById('analyticsDomainsSelect');
    const domainLabel = (d && d.value !== 'all') ? d.value : 'All Domains';
    const ph = document.getElementById('printHeaderDomain');
    const pr = document.getElementById('printHeaderRange');
    const pt = document.getElementById('printHeaderDate');
    if (ph) ph.textContent = domainLabel;
    if (pr) pr.textContent = `${fromDate}  →  ${toDate}`;
    if (pt) pt.textContent = `Exported on ${new Date().toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' })}`;
    window.print();
  }

  // ── Skeletons / errors ──────────────────────────────────────────────────────
  function showSkeletons() {
    const el = document.getElementById('analyticsStats');
    if (el) el.innerHTML = Array(5).fill(0).map(() => `
      <div class="card-outer stat-card"><div class="card-inner">
        <div><span class="skeleton" style="width:32px;height:32px;border-radius:8px;display:inline-block"></span></div>
        <div style="margin-top:12px"><span class="skeleton" style="width:72px;height:30px;display:inline-block;border-radius:6px"></span></div>
        <div style="margin-top:8px"><span class="skeleton" style="width:80px;height:11px;display:inline-block;border-radius:4px"></span></div>
      </div></div>`).join('');

    ['analyticsTopPages','analyticsSourceList','analyticsDevices','analyticsBrowsers',
     'analyticsOS','analyticsReferrers','analyticsGeo','analyticsTrafficBreakdown'].forEach(id => {
      const e = document.getElementById(id);
      if (e) e.innerHTML = `<div class="skeleton" style="height:120px;border-radius:var(--radius-md)"></div>`;
    });
  }

  function showErrorState(msg) {
    const el = document.getElementById('analyticsStats');
    if (el) el.innerHTML = `<div style="grid-column:1/-1">
      <div class="empty-state" style="padding:var(--space-8)">
        <p class="text-red text-sm">${esc(msg || 'Failed to load analytics data.')}</p>
      </div></div>`;
  }

  // ── Icons ───────────────────────────────────────────────────────────────────
  function iconEye()     { return '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="2.5"/><path d="M1 8C2.5 4.5 5 2 8 2s5.5 2.5 7 6c-1.5 3.5-4 6-7 6S2.5 11.5 1 8z"/></svg>'; }
  function iconUsers()   { return '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="6" cy="5" r="3"/><path d="M1 14c0-3 2-5 5-5h2c3 0 5 2 5 5"/></svg>'; }
  function iconZap()     { return '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 1L3 9h6l-2 6 8-8H9z"/></svg>'; }
  function iconPercent() { return '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="4.5" cy="4.5" r="2"/><circle cx="11.5" cy="11.5" r="2"/><path d="M3 13L13 3"/></svg>'; }
  function iconClock()   { return '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6.5"/><path d="M8 4v4l3 2"/></svg>'; }

  // ── Formatting helpers ──────────────────────────────────────────────────────
  function fmtNum(n) {
    if (n === null || n === undefined) return '—';
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 10_000)    return (n / 1_000).toFixed(0) + 'K';
    if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K';
    return n.toLocaleString();
  }

  function fmtDuration(sec) {
    if (!sec) return '—';
    if (sec >= 3600) return `${Math.floor(sec/3600)}h ${Math.floor((sec%3600)/60)}m`;
    if (sec >= 60)   return `${Math.floor(sec/60)}m ${sec%60}s`;
    return `${sec}s`;
  }

  // Format date labels — buckets from the server are "local-shifted UTC" so format with timeZone:'UTC'
  function fmtDateLabel(iso) {
    const d = new Date(iso);
    if (granularity === 'hourly')  return d.toLocaleTimeString('en-US', { hour:'numeric', hour12:true, timeZone:'UTC' });
    if (granularity === 'monthly') return d.toLocaleDateString('en-US', { month:'short', year:'2-digit', timeZone:'UTC' });
    if (granularity === 'weekly')  return d.toLocaleDateString('en-US', { month:'short', day:'numeric', timeZone:'UTC' });
    return d.toLocaleDateString('en-US', { month:'short', day:'numeric', timeZone:'UTC' });
  }

  function fmtUrl(url) {
    if (!url || url === '/') return '/ (Home)';
    if (url.length > 44) return url.slice(0, 20) + '…' + url.slice(-22);
    return url;
  }

  function hexAlpha(hex, a) {
    const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
    return `rgba(${r},${g},${b},${a})`;
  }

  function pct(val, max) { return max > 0 ? Math.round((val / max) * 100) : 0; }
  function esc(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function emptyState(msg) { return `<div class="empty-state" style="padding:var(--space-5)"><p class="text-sm text-muted">${msg}</p></div>`; }

  return {
    init, load, exportPDF, exportCSV, geoDrill, geoDrillBack,
    openPageDrilldown, openNewReportModal, saveNewReport,
    sendReportNow, toggleReport, deleteReport, switchTab,
  };
})();
