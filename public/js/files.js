'use strict';
window.filesMgr = (() => {
  let _domain  = null;
  let _path    = '.';
  let _domains = [];

  const TEXT_EXTS = new Set(['.php','.html','.htm','.js','.css','.json','.xml','.txt','.md','.env','.htaccess','.conf','.sh','.py','.rb','.yml','.yaml','.ini','.log','.svg']);

  async function load() {
    const data = await api.get('/api/domains');
    if (!data?.success) return;
    _domains = (data.data || []).filter(d => !d.domain.endsWith('-le-ssl'));
    const sel = document.getElementById('filesDomainSelect');
    if (!sel) return;
    sel.innerHTML = _domains.map(d => `<option value="${d.domain}">${d.domain}</option>`).join('');
    if (_domains.length) {
      _domain = _domain || _domains[0].domain;
      sel.value = _domain;
      await browse('.');
    }
  }

  async function onDomainChange() {
    _domain = document.getElementById('filesDomainSelect').value;
    _path   = '.';
    await browse('.');
  }

  async function browse(targetPath) {
    _path = targetPath;
    document.getElementById('filesLoadingOverlay').style.display = '';
    const data = await api.get(`/api/files?domain=${encodeURIComponent(_domain)}&path=${encodeURIComponent(targetPath)}`);
    document.getElementById('filesLoadingOverlay').style.display = 'none';
    if (!data?.success) return toast('error', 'Files', data?.error);
    renderBreadcrumb(data.data.path);
    renderEntries(data.data.entries, data.data.path);
  }

  function renderBreadcrumb(currentPath) {
    const el = document.getElementById('filesBreadcrumb');
    if (!el) return;
    const parts = currentPath === '.' ? [] : currentPath.split('/').filter(Boolean);
    let html = `<span class="breadcrumb-item" onclick="window.filesMgr.browse('.')" style="cursor:pointer;color:var(--accent)">root</span>`;
    let built = '';
    parts.forEach((p, i) => {
      built += (built ? '/' : '') + p;
      const path = built;
      html += ` <span style="color:var(--text-muted)">›</span> `;
      if (i === parts.length - 1) {
        html += `<span style="color:var(--text-primary)">${p}</span>`;
      } else {
        html += `<span class="breadcrumb-item" onclick="window.filesMgr.browse('${path}')" style="cursor:pointer;color:var(--accent)">${p}</span>`;
      }
    });
    el.innerHTML = html;
  }

  function renderEntries(entries, currentPath) {
    const tbody = document.getElementById('filesTable');
    if (!entries.length) {
      tbody.innerHTML = `<tr><td colspan="4"><div class="empty-state"><p>Empty directory.</p></div></td></tr>`;
      return;
    }

    // Add ".." row if not at root
    let rows = '';
    if (currentPath && currentPath !== '.') {
      const parent = currentPath.includes('/') ? currentPath.split('/').slice(0, -1).join('/') : '.';
      rows += `<tr>
        <td colspan="3" style="cursor:pointer" onclick="window.filesMgr.browse('${parent}')">
          <span style="font-family:var(--font-mono);color:var(--accent)">← ..</span>
        </td><td></td></tr>`;
    }

    rows += entries.map(e => {
      const entryPath = currentPath === '.' ? e.name : `${currentPath}/${e.name}`;
      const icon = e.type === 'dir' ? '📁' : '📄';
      const size = e.type === 'file' ? formatSize(e.size) : '—';
      const canEdit = e.type === 'file' && TEXT_EXTS.has(e.ext);
      return `
        <tr>
          <td style="cursor:pointer;font-family:var(--font-mono);font-size:0.8125rem"
            onclick="${e.type === 'dir' ? `window.filesMgr.browse('${entryPath}')` : ''}">
            ${icon} ${e.name}
          </td>
          <td style="font-size:0.8125rem;color:var(--text-muted)">${size}</td>
          <td style="font-size:0.8125rem;color:var(--text-muted)">${new Date(e.modified).toLocaleDateString()}</td>
          <td style="text-align:right;display:flex;gap:4px;justify-content:flex-end">
            ${canEdit ? `<button class="btn btn-ghost btn-xs" onclick="window.filesMgr.openEditor('${entryPath}')">Edit</button>` : ''}
            ${e.type === 'file' ? `<a class="btn btn-ghost btn-xs" href="/api/files/download?domain=${encodeURIComponent(_domain)}&path=${encodeURIComponent(entryPath)}" download>↓</a>` : ''}
            <button class="btn btn-danger btn-xs" onclick="window.filesMgr.deleteEntry('${entryPath}', '${e.type}')">✕</button>
          </td>
        </tr>`;
    }).join('');

    tbody.innerHTML = rows;
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  async function deleteEntry(filePath, type) {
    if (!confirm(`Delete ${type} "${filePath}"? This cannot be undone.`)) return;
    const data = await api.del('/api/files', { domain: _domain, path: filePath });
    if (data?.success) { toast('success', 'Deleted', filePath); browse(_path); }
    else toast('error', 'Failed', data?.error);
  }

  // ── Editor ───────────────────────────────────────────────────────────────────
  let _editPath = null;
  async function openEditor(filePath) {
    _editPath = filePath;
    document.getElementById('editorFilename').textContent = filePath;
    document.getElementById('editorContent').value = 'Loading…';
    document.getElementById('modalFileEditor').classList.add('open');
    const data = await api.get(`/api/files/read?domain=${encodeURIComponent(_domain)}&path=${encodeURIComponent(filePath)}`);
    if (data?.success) document.getElementById('editorContent').value = data.data.content;
    else { toast('error', 'Load failed', data?.error); document.getElementById('editorContent').value = ''; }
  }

  async function saveFile() {
    const content = document.getElementById('editorContent').value;
    const btn = document.getElementById('editorSaveBtn');
    btn.disabled = true; btn.textContent = 'Saving…';
    const data = await api.post('/api/files/write', { domain: _domain, path: _editPath, content });
    btn.disabled = false; btn.textContent = 'Save';
    if (data?.success) { toast('success', 'Saved', _editPath); document.getElementById('modalFileEditor').classList.remove('open'); }
    else toast('error', 'Save failed', data?.error);
  }

  // ── Upload ───────────────────────────────────────────────────────────────────
  async function uploadFiles() {
    const input = document.getElementById('filesUploadInput');
    if (!input?.files?.length) return toast('error', 'Upload', 'Select files first.');
    const form = new FormData();
    form.append('domain', _domain);
    form.append('path', _path);
    for (const f of input.files) form.append('files', f);
    const btn = document.getElementById('filesUploadBtn');
    btn.disabled = true; btn.textContent = 'Uploading…';
    try {
      const resp = await fetch('/api/files/upload', { method: 'POST', body: form });
      const data = await resp.json();
      if (data?.success) { toast('success', 'Uploaded', `${data.data.uploaded} file(s)`); browse(_path); }
      else toast('error', 'Upload failed', data?.error);
    } catch (e) { toast('error', 'Upload error', e.message); }
    btn.disabled = false; btn.textContent = 'Upload';
    input.value = '';
  }

  // ── New folder ───────────────────────────────────────────────────────────────
  async function createFolder() {
    const name = prompt('Folder name:');
    if (!name) return;
    const newPath = _path === '.' ? name : `${_path}/${name}`;
    const data = await api.post('/api/files/mkdir', { domain: _domain, path: newPath });
    if (data?.success) { toast('success', 'Created', newPath); browse(_path); }
    else toast('error', 'Failed', data?.error);
  }

  return { load, onDomainChange, browse, deleteEntry, openEditor, saveFile, uploadFiles, createFolder };
})();
