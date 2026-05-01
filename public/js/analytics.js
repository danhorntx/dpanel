// ── DAnalytics frontend module ────────────────────────────────────────────────
// Vanilla JS IIFE, consistent with every other DPanel module.
// Requires: Chart.js 4 loaded globally, window.api wrapper, window.toast.
window.analyticsModule = (() => {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────────
  let domain      = 'all';
  let granularity = 'daily';
  let trafficType = 'real';
  let fromDate    = '';
  let toDate      = '';
  let geoLevel    = 'country';
  let geoFilter   = {};
  let geoCache    = null;
  let realtimeTimer  = null;
  let debounceTimer  = null;
  let timeChart      = null;
  let sourceChart    = null;
  let initialized    = false;
  let loading        = false;

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

  // ── Country code → full name (top ~80 countries) ──────────────────────────
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

  function countryName(code) {
    if (!code) return 'Unknown';
    return COUNTRY_NAMES[code.toUpperCase()] || code.toUpperCase();
  }

  function countryFlag(code) {
    if (!code || code.length !== 2) return '';
    const offset = 0x1F1E6 - 65;
    return String.fromCodePoint(code.toUpperCase().charCodeAt(0) + offset) +
           String.fromCodePoint(code.toUpperCase().charCodeAt(1) + offset);
  }

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
  function init() {
    if (initialized) { load(); return; }
    initialized = true;

    setPreset(30);

    document.querySelectorAll('.analytics-preset').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.analytics-preset').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const days = btn.dataset.days;
        if (days === 'today') {
          const today = new Date().toISOString().slice(0, 10);
          fromDate = toDate = today;
          document.getElementById('analyticsFrom').value = today;
          document.getElementById('analyticsTo').value   = today;
          // Auto-switch to hourly for single-day view
          setGranularity('hourly');
        } else if (days === 'ytd') {
          const now = new Date();
          fromDate = `${now.getUTCFullYear()}-01-01`;
          toDate   = now.toISOString().slice(0, 10);
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
    if (domainSel) domainSel.addEventListener('change', () => { domain = domainSel.value; load(); });

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

    loadDomains();
    startRealtime();
    load();
  }

  function setGranularity(gran) {
    granularity = gran;
    document.querySelectorAll('.analytics-gran').forEach(b => {
      b.classList.toggle('active', b.dataset.gran === gran);
    });
  }

  function setPreset(days) {
    const to   = new Date();
    const from = new Date(to.getTime() - days * 86400000);
    fromDate = from.toISOString().slice(0, 10);
    toDate   = to.toISOString().slice(0, 10);
    const fEl = document.getElementById('analyticsFrom');
    const tEl = document.getElementById('analyticsTo');
    if (fEl) fEl.value = fromDate;
    if (tEl) tEl.value = toDate;
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

    const params = new URLSearchParams({ domain, from: fromDate, to: toDate, granularity, trafficType });
    const [statsResp, geoResp] = await Promise.all([
      api.get('/api/analytics/stats?' + params),
      api.get('/api/analytics/geo?' + new URLSearchParams({ domain, from: fromDate, to: toDate, trafficType })),
    ]);

    loading = false;

    if (!statsResp?.success) { showErrorState(statsResp?.error); return; }

    geoCache = geoResp?.success ? geoResp.data : null;
    render(statsResp.data);
    renderGeo();
    loadTrafficBreakdown();
  }

  // ── Traffic breakdown ───────────────────────────────────────────────────────
  async function loadTrafficBreakdown() {
    const el = document.getElementById('analyticsTrafficBreakdown');
    if (!el) return;

    const params = new URLSearchParams({ domain, from: fromDate, to: toDate, granularity: 'daily', trafficType: 'all' });
    const allData = await api.get('/api/analytics/stats?' + params);
    if (!allData?.success) { el.innerHTML = emptyState('No traffic classification data.'); return; }

    const allPV = allData.data?.summary?.pageviews || 0;

    const [realResp, botsResp] = await Promise.all([
      api.get('/api/analytics/stats?' + new URLSearchParams({ domain, from: fromDate, to: toDate, granularity: 'daily', trafficType: 'real' })),
      api.get('/api/analytics/stats?' + new URLSearchParams({ domain, from: fromDate, to: toDate, granularity: 'daily', trafficType: 'bots' })),
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
        ${fmtNum(allPV)} total requests processed · Real user rate: <strong style="color:${C.green}">${pct(realPV, allPV)}%</strong>
      </p>`;
  }

  // ── Master render ───────────────────────────────────────────────────────────
  function render(d) {
    renderSummaryCards(d.summary);
    renderTimeSeries(d.timeSeries, d.summary);
    renderTopPages(d.topPages);
    renderSources(d.sources);
    renderBreakdown('analyticsDevices',  d.devices,          DEVICE_COLORS);
    renderBreakdown('analyticsBrowsers', d.browsers,         BROWSER_COLORS);
    renderBreakdown('analyticsOS',       d.operatingSystems, OS_COLORS);
    renderReferrers(d.referrers);
  }

  // ── Summary cards ───────────────────────────────────────────────────────────
  function renderSummaryCards(s) {
    const el = document.getElementById('analyticsStats');
    if (!el) return;

    const typeBadge = {
      real: `<span class="a-type-badge" style="background:${C.green}22;color:${C.green}">Real Users</span>`,
      bots: `<span class="a-type-badge" style="background:${C.red}22;color:${C.red}">Bots</span>`,
      all:  `<span class="a-type-badge" style="background:rgba(255,255,255,.08);color:var(--text-muted)">All Traffic</span>`,
    }[trafficType] || '';

    const cards = [
      { label: 'Page Views',      value: fmtNum(s.pageviews),           sub: 'total requests',           color: C.blue,                                       icon: iconEye(),     badge: typeBadge },
      { label: 'Unique Visitors', value: fmtNum(s.uniqueVisitors),      sub: 'distinct IPs',              color: C.green,                                      icon: iconUsers(),   badge: '' },
      { label: 'Sessions',        value: fmtNum(s.sessions),            sub: '30-min idle = new session', color: C.amber,                                      icon: iconZap(),     badge: '' },
      { label: 'Bounce Rate',     value: s.bounceRate + '%',            sub: 'single-page sessions',      color: s.bounceRate > 70 ? C.red : C.muted,          icon: iconPercent(), badge: '' },
      { label: 'Avg Duration',    value: fmtDuration(s.avgDurationSec), sub: 'engaged sessions only',     color: C.teal,                                       icon: iconClock(),   badge: '' },
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
        </div>
      </div>
    `).join('');
  }

  // ── Time-series area chart ─────────────────────────────────────────────────
  function renderTimeSeries(series, summary) {
    const canvas = document.getElementById('analyticsTimeChart');
    if (!canvas) return;
    if (timeChart) { timeChart.destroy(); timeChart = null; }

    // Filter out zero-only tail if viewing today with sparse data
    const nonZeroSeries = series.filter((p, i, arr) => {
      if (p.count > 0) return true;
      // Keep zeros between non-zero points
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

    // Update chart header total
    const totalEl = document.getElementById('analyticsChartTotal');
    if (totalEl) {
      totalEl.textContent = `${fmtNum(totalPV)} page views`;
    }

    timeChart = new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [{
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
        }],
      },
      options: {
        responsive:          true,
        maintainAspectRatio: false,
        interaction:         { mode: 'index', intersect: false },
        animation:           { duration: 500, easing: 'easeOutQuart' },
        plugins: {
          legend: { display: false },
          tooltip: {
            ...TOOLTIP,
            callbacks: {
              title: items => {
                // Full date in tooltip
                const iso = displaySeries[items[0].dataIndex]?.date;
                if (!iso) return items[0].label;
                const d = new Date(iso);
                if (granularity === 'hourly') {
                  return d.toLocaleString('en-US', { weekday:'short', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit', hour12:true, timeZone:'UTC' });
                }
                return d.toLocaleDateString('en-US', { weekday:'short', month:'long', day:'numeric', year:'numeric', timeZone:'UTC' });
              },
              label: item => {
                const v = item.raw;
                return `  ${fmtNum(v)} ${v === 1 ? 'page view' : 'page views'}`;
              },
              afterLabel: item => {
                if (maxVal > 0 && item.raw > 0) {
                  return `  ${Math.round((item.raw / totalPV) * 100)}% of period total`;
                }
                return '';
              },
            },
          },
        },
        scales: {
          x: {
            grid:   { color: 'rgba(255,255,255,0.035)', drawBorder: false },
            ticks:  {
              color:         C.text,
              font:          { family: "'DM Sans',sans-serif", size: 11 },
              maxTicksLimit: granularity === 'hourly' ? 12 : 10,
              maxRotation:   0,
            },
            border: { display: false },
          },
          y: {
            grid:   { color: 'rgba(255,255,255,0.035)', drawBorder: false },
            ticks:  {
              color:    C.text,
              font:     { family: "'DM Sans',sans-serif", size: 11 },
              callback: v => Number.isInteger(v) ? fmtNum(v) : '',
              // Prevent fractional ticks on small datasets
              precision: 0,
              maxTicksLimit: 6,
            },
            border:      { display: false },
            beginAtZero: true,
            suggestedMax: Math.max(maxVal * 1.15, 5),
          },
        },
      },
    });
  }

  // ── Top pages ───────────────────────────────────────────────────────────────
  function renderTopPages(pages) {
    const el = document.getElementById('analyticsTopPages');
    if (!el) return;
    if (!pages?.length) { el.innerHTML = emptyState('No page data for this range.'); return; }
    const max = pages[0].count;
    const total = pages.reduce((s, p) => s + p.count, 0);
    el.innerHTML = pages.slice(0, 12).map((p, i) => `
      <div class="a-bar-row">
        <div class="a-bar-rank">${i + 1}</div>
        <div class="a-bar-label" title="${esc(p.name)}">${esc(fmtUrl(p.name))}</div>
        <div class="a-bar-track">
          <div class="a-bar-fill" style="width:${pct(p.count, max)}%;background:${C.blue}"></div>
        </div>
        <div class="a-bar-pct">${pct(p.count, total)}%</div>
        <div class="a-bar-count">${fmtNum(p.count)}</div>
      </div>`).join('');
  }

  // ── Traffic sources chart + legend ──────────────────────────────────────────
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
        data: {
          labels,
          datasets: [{
            data:            counts,
            backgroundColor: colors,
            borderColor:     '#141820',
            borderWidth:     3,
            hoverOffset:     8,
          }],
        },
        options: {
          responsive:          true,
          maintainAspectRatio: false,
          cutout:              '68%',
          animation:           { duration: 500 },
          plugins: {
            legend: { display: false },
            tooltip: {
              ...TOOLTIP,
              displayColors: true,
              callbacks: {
                label: item => `  ${item.label}: ${fmtNum(item.raw)} (${pct(item.raw, total)}%)`,
              },
            },
          },
        },
        // Center text plugin (inline)
        plugins: [{
          id: 'centerText',
          afterDraw(chart) {
            const { ctx, chartArea: { top, bottom, left, right } } = chart;
            const cx = (left + right) / 2;
            const cy = (top + bottom) / 2;
            ctx.save();
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = '#e4e8f0';
            ctx.font = "600 1.4rem 'DM Sans',sans-serif";
            ctx.fillText(fmtNum(total), cx, cy - 8);
            ctx.fillStyle = '#7a86a0';
            ctx.font = "400 0.7rem 'DM Sans',sans-serif";
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

  // ── Generic breakdown bars (devices / browsers / OS) ───────────────────────
  // Uses a dot instead of a rank number — 4-col grid via class `no-rank`
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
        <div class="a-bar-track">
          <div class="a-bar-fill" style="width:${pct(item.count, max)}%;background:${colorMap[item.name] || C.muted}"></div>
        </div>
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
             onmouseover="this.style.textDecoration='underline'"
             onmouseout="this.style.textDecoration='none'"
          >${esc(r.name)}</a>
        </div>
        <div class="a-bar-track">
          <div class="a-bar-fill" style="width:${pct(r.count, max)}%;background:${C.purple}"></div>
        </div>
        <div class="a-bar-pct">${pct(r.count, total)}%</div>
        <div class="a-bar-count">${fmtNum(r.count)}</div>
      </div>`).join('');
  }

  // ── Geographic breakdown ────────────────────────────────────────────────────
  function renderGeo() {
    const el = document.getElementById('analyticsGeo');
    if (!el) return;

    if (!geoCache) {
      el.innerHTML = emptyState('Geographic data not available yet — check back after the ingester has run.');
      return;
    }

    if (geoLevel === 'country')      renderGeoCountries(el);
    else if (geoLevel === 'region')  renderGeoRegions(el);
    else                              renderGeoCities(el);

    const backBtn = document.getElementById('geoBackBtn');
    if (backBtn) backBtn.style.display = geoLevel !== 'country' ? '' : 'none';
  }

  function renderGeoCountries(el) {
    const countries = geoCache?.countries || [];
    if (!countries.length) { el.innerHTML = emptyState('No geographic data for this range.'); return; }
    const max   = countries[0].count;
    const total = countries.reduce((s, r) => s + r.count, 0);

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
        <div class="a-bar-track">
          <div class="a-bar-fill" style="width:${pct(r.count, max)}%;background:${C.blue}"></div>
        </div>
        <div class="a-bar-pct">${pct(r.count, total)}%</div>
        <div class="a-bar-count">${fmtNum(r.count)}</div>
      </div>`).join('') +
      `<p style="font-size:.72rem;color:var(--text-muted);margin-top:10px">Click a country to drill into regions</p>`;
  }

  function renderGeoRegions(el) {
    const regions = (geoCache?.regions || []).filter(r => r.country === geoFilter.country);
    if (!regions.length) { el.innerHTML = emptyState(`No region data for ${countryName(geoFilter.country)}.`); return; }
    const max   = regions[0].count;
    const total = regions.reduce((s, r) => s + r.count, 0);

    el.innerHTML = `
      <p style="font-size:.8rem;color:var(--text-muted);margin-bottom:10px">
        ${countryFlag(geoFilter.country)} ${esc(countryName(geoFilter.country))} · Regions
      </p>
      ${regions.slice(0, 25).map((r, i) => {
        const label = (geoFilter.country === 'US' && US_STATES[r.region]) ? US_STATES[r.region] : (r.region || 'Unknown');
        return `
          <div class="a-bar-row a-geo-row" tabindex="0" role="button"
               onclick="window.analyticsModule.geoDrill('region','${esc(r.region)}')"
               onkeydown="if(event.key==='Enter')window.analyticsModule.geoDrill('region','${esc(r.region)}')">
            <div class="a-bar-rank">${i + 1}</div>
            <div class="a-bar-label">${esc(label)}</div>
            <div class="a-bar-track">
              <div class="a-bar-fill" style="width:${pct(r.count, max)}%;background:${C.teal}"></div>
            </div>
            <div class="a-bar-pct">${pct(r.count, total)}%</div>
            <div class="a-bar-count">${fmtNum(r.count)}</div>
          </div>`;
      }).join('')}
      <p style="font-size:.72rem;color:var(--text-muted);margin-top:10px">Click a region to see city breakdown</p>`;
  }

  function renderGeoCities(el) {
    const cities = (geoCache?.cities || []).filter(r => r.country === geoFilter.country && r.region === geoFilter.region);
    if (!cities.length) { el.innerHTML = emptyState(`No city data for ${geoFilter.country} / ${geoFilter.region}.`); return; }
    const max   = cities[0].count;
    const total = cities.reduce((s, r) => s + r.count, 0);
    const regionLabel = (geoFilter.country === 'US' && US_STATES[geoFilter.region]) ? US_STATES[geoFilter.region] : geoFilter.region;

    el.innerHTML = `
      <p style="font-size:.8rem;color:var(--text-muted);margin-bottom:10px">
        ${countryFlag(geoFilter.country)} ${esc(countryName(geoFilter.country))} › ${esc(regionLabel)} · Cities
      </p>
      ${cities.slice(0, 25).map((r, i) => `
        <div class="a-bar-row">
          <div class="a-bar-rank">${i + 1}</div>
          <div class="a-bar-label">${esc(r.city || 'Unknown')}</div>
          <div class="a-bar-track">
            <div class="a-bar-fill" style="width:${pct(r.count, max)}%;background:${C.purple}"></div>
          </div>
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
    el.style.display    = n > 0 ? '' : 'none';
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
    if (el) el.innerHTML = `
      <div style="grid-column:1/-1">
        <div class="empty-state" style="padding:var(--space-8)">
          <p class="text-red text-sm">${esc(msg || 'Failed to load analytics data.')}</p>
        </div>
      </div>`;
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

  // All buckets are UTC — format labels in UTC to match
  function fmtDateLabel(iso) {
    const d = new Date(iso);
    if (granularity === 'hourly')  return d.toLocaleTimeString('en-US', { hour:'numeric', hour12:true, timeZone:'UTC' });
    if (granularity === 'monthly') return d.toLocaleDateString('en-US', { month:'short', year:'2-digit', timeZone:'UTC' });
    if (granularity === 'weekly')  return d.toLocaleDateString('en-US', { month:'short', day:'numeric', timeZone:'UTC' });
    return d.toLocaleDateString('en-US', { month:'short', day:'numeric', timeZone:'UTC' });
  }

  // Format URL for display: show just the path, abbreviated if needed
  function fmtUrl(url) {
    if (!url || url === '/') return '/ (Home)';
    // Trim long URLs from the right, preserving the end (most specific part)
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

  return { init, load, exportPDF, geoDrill, geoDrillBack };
})();
