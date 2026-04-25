// ── Logs module ───────────────────────────────────────────────────────────────
window.logs = (() => {
  let rawLines = [];

  async function load() {
    const source = document.getElementById('logSource').value;
    const el = document.getElementById('logOutput');
    el.textContent = 'Loading...';
    const data = await api.get(`/api/logs?source=${source}&lines=200`);
    if (!data?.success) { el.textContent = `Error: ${data?.error}`; return; }
    rawLines = data.data;
    render(rawLines);
  }

  function render(lines) {
    const el = document.getElementById('logOutput');
    if (!lines.length) { el.textContent = 'No log entries found.'; return; }
    el.innerHTML = lines.map(line => {
      const lower = line.toLowerCase();
      let cls = '';
      if (lower.includes('error') || lower.includes('crit') || lower.includes('emerg')) cls = 'log-line error';
      else if (lower.includes('warn') || lower.includes('notice')) cls = 'log-line warn';
      else if (lower.includes('info') || lower.includes('notice')) cls = 'log-line info';
      const escaped = line.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      return `<span class="${cls}">${escaped}\n</span>`;
    }).join('');
    el.scrollTop = el.scrollHeight;
  }

  function filter(query) {
    if (!query) { render(rawLines); return; }
    const q = query.toLowerCase();
    render(rawLines.filter(l => l.toLowerCase().includes(q)));
  }

  function download() {
    const source = document.getElementById('logSource').value;
    window.open(`/api/logs/download?source=${source}`, '_blank');
  }

  return { load, filter, download };
})();
