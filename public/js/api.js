// ── DPanel API wrapper ────────────────────────────────────────────────────────
window.api = {
  async get(url) {
    const res = await fetch(url, { credentials: 'include' });
    if (res.status === 401) { window.location.href = '/'; return; }
    return res.json();
  },
  async post(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (res.status === 401) { window.location.href = '/'; return; }
    return res.json();
  },
  async put(url, body) {
    const res = await fetch(url, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (res.status === 401) { window.location.href = '/'; return; }
    return res.json();
  },
  async del(url) {
    const res = await fetch(url, { method: 'DELETE', credentials: 'include' });
    if (res.status === 401) { window.location.href = '/'; return; }
    return res.json();
  }
};
