'use strict';
const express  = require('express');
const fs       = require('fs');
const path     = require('path');
const multer   = require('multer');
const apache   = require('../lib/apache');
const { sanitizeDomain } = require('../lib/shell');
const router   = express.Router();

// Multer: store uploads in /tmp
const upload = multer({ dest: '/tmp/dpanel-uploads/', limits: { fileSize: 100 * 1024 * 1024 } });

// ── Resolve a safe path within a docroot ──────────────────────────────────────
function safePath(docRoot, rel) {
  const resolved = path.resolve(docRoot, rel || '');
  if (!resolved.startsWith(path.resolve(docRoot))) throw new Error('Path traversal detected.');
  return resolved;
}

function getDomainDocRoot(domain) {
  sanitizeDomain(domain);
  const vhosts = apache.listVhosts().filter(v => !v.domain.endsWith('-le-ssl'));
  const vhost  = vhosts.find(v => v.domain === domain);
  if (!vhost || !vhost.docRoot) throw new Error('Domain not found.');
  return vhost.docRoot;
}

// ── GET /api/files?domain=&path= — list directory ────────────────────────────
router.get('/', (req, res) => {
  try {
    const docRoot = getDomainDocRoot(req.query.domain);
    const target  = safePath(docRoot, req.query.path || '');
    if (!fs.existsSync(target)) return res.json({ success: false, error: 'Path not found.' });

    const stat = fs.statSync(target);
    if (!stat.isDirectory()) return res.json({ success: false, error: 'Not a directory.' });

    const entries = fs.readdirSync(target).map(name => {
      const full = path.join(target, name);
      const s    = fs.statSync(full);
      return {
        name,
        type:     s.isDirectory() ? 'dir' : 'file',
        size:     s.size,
        modified: s.mtime.toISOString(),
        ext:      s.isFile() ? path.extname(name).toLowerCase() : null,
      };
    }).sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    const relPath = path.relative(docRoot, target);
    res.json({ success: true, data: { path: relPath || '.', entries, docRoot } });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// ── GET /api/files/read?domain=&path= — read file contents ───────────────────
router.get('/read', (req, res) => {
  try {
    const docRoot = getDomainDocRoot(req.query.domain);
    const target  = safePath(docRoot, req.query.path || '');
    const stat    = fs.statSync(target);
    if (!stat.isFile()) return res.json({ success: false, error: 'Not a file.' });
    if (stat.size > 1024 * 1024) return res.json({ success: false, error: 'File too large to edit (>1MB).' });

    const content = fs.readFileSync(target, 'utf8');
    res.json({ success: true, data: { content, path: req.query.path } });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// ── POST /api/files/write — save file contents ────────────────────────────────
router.post('/write', (req, res) => {
  try {
    const { domain, path: filePath, content } = req.body;
    const docRoot = getDomainDocRoot(domain);
    const target  = safePath(docRoot, filePath);
    fs.writeFileSync(target, content);
    res.json({ success: true });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// ── POST /api/files/mkdir — create directory ──────────────────────────────────
router.post('/mkdir', (req, res) => {
  try {
    const { domain, path: dirPath } = req.body;
    const docRoot = getDomainDocRoot(domain);
    const target  = safePath(docRoot, dirPath);
    fs.mkdirSync(target, { recursive: true });
    res.json({ success: true });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// ── POST /api/files/rename ────────────────────────────────────────────────────
router.post('/rename', (req, res) => {
  try {
    const { domain, from, to } = req.body;
    const docRoot = getDomainDocRoot(domain);
    fs.renameSync(safePath(docRoot, from), safePath(docRoot, to));
    res.json({ success: true });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// ── DELETE /api/files — delete file or directory ──────────────────────────────
router.delete('/', (req, res) => {
  try {
    const { domain, path: filePath } = req.body;
    const docRoot = getDomainDocRoot(domain);
    const target  = safePath(docRoot, filePath);
    const stat    = fs.statSync(target);
    if (stat.isDirectory()) fs.rmSync(target, { recursive: true });
    else fs.unlinkSync(target);
    res.json({ success: true });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// ── POST /api/files/upload — upload files ────────────────────────────────────
router.post('/upload', upload.array('files'), (req, res) => {
  try {
    const docRoot    = getDomainDocRoot(req.body.domain);
    const targetDir  = safePath(docRoot, req.body.path || '');
    if (!fs.existsSync(targetDir)) return res.json({ success: false, error: 'Target path not found.' });

    for (const file of req.files) {
      const dest = path.join(targetDir, file.originalname);
      fs.renameSync(file.path, dest);
    }
    res.json({ success: true, data: { uploaded: req.files.length } });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// ── GET /api/files/download?domain=&path= — download file ────────────────────
router.get('/download', (req, res) => {
  try {
    const docRoot = getDomainDocRoot(req.query.domain);
    const target  = safePath(docRoot, req.query.path);
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      return res.status(404).json({ success: false, error: 'File not found.' });
    }
    res.download(target, path.basename(target));
  } catch (err) { res.json({ success: false, error: err.message }); }
});

module.exports = router;
