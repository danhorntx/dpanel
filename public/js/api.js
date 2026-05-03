// ── DPanel API wrapper ────────────────────────────────────────────────────────
// safeJson: parses JSON but returns { success:false, error } if the server
// returns HTML (e.g. a 404 catch-all) instead of throwing a parse error.
async function safeJson(res) {
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    return { success: false, error: `Server returned ${res.status} (non-JSON response)` };
  }
  return res.json();
}

window.api = {
  async get(url) {
    const res = await fetch(url, { credentials: 'include' });
    if (res.status === 401) { window.location.href = '/'; return; }
    return safeJson(res);
  },
  async post(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (res.status === 401) { window.location.href = '/'; return; }
    return safeJson(res);
  },
  async put(url, body) {
    const res = await fetch(url, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (res.status === 401) { window.location.href = '/'; return; }
    return safeJson(res);
  },
  async patch(url, body) {
    const res = await fetch(url, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (res.status === 401) { window.location.href = '/'; return; }
    return safeJson(res);
  },
  async del(url) {
    const res = await fetch(url, { method: 'DELETE', credentials: 'include' });
    if (res.status === 401) { window.location.href = '/'; return; }
    return safeJson(res);
  },
  // Alias — some modules call api.delete(), others api.del()
  async delete(url) {
    return this.del(url);
  }
};
