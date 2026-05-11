'use strict';
const express  = require('express');
const fs       = require('fs');
const path     = require('path');
const multer   = require('multer');
const { execFileSync } = require('child_process');
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
        // POSIX mode as octal "755", "644", etc. — useful for chmod UI
        mode:     (s.mode & 0o777).toString(8).padStart(3, '0'),
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
      // Strip any path components from the original name — only keep the basename
      const safeName = path.basename(file.originalname).replace(/[^\w\s.\-]/g, '_');
      const dest = path.join(targetDir, safeName);
      fs.renameSync(file.path, dest);
    }
    res.json({ success: true, data: { uploaded: req.files.length } });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// ── POST /api/files/chmod — change permissions ────────────────────────────────
// mode: octal string ("755", "644", etc.). We refuse anything that wouldn't
// fit in 4 octal digits to avoid surprises with setuid/setgid bits.
router.post('/chmod', (req, res) => {
  try {
    const { domain, path: filePath, mode } = req.body;
    if (!/^[0-7]{3,4}$/.test(String(mode || ''))) return res.json({ success: false, error: 'Mode must be 3 or 4 octal digits.' });
    const docRoot = getDomainDocRoot(domain);
    const target  = safePath(docRoot, filePath);
    fs.chmodSync(target, parseInt(mode, 8));
    res.json({ success: true });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// ── POST /api/files/extract — unpack an archive in place ──────────────────────
// Supported: .zip, .tar.gz, .tgz, .tar, .tar.bz2. Format inferred from
// extension. Destination defaults to the archive's parent directory.
router.post('/extract', (req, res) => {
  try {
    const { domain, archive, dest } = req.body;
    const docRoot = getDomainDocRoot(domain);
    const archPath = safePath(docRoot, archive);
    if (!fs.existsSync(archPath) || !fs.statSync(archPath).isFile()) {
      return res.json({ success: false, error: 'Archive not found.' });
    }
    const destRel  = dest || path.dirname(archive);
    const destPath = safePath(docRoot, destRel);
    fs.mkdirSync(destPath, { recursive: true });

    // Pick command by extension. execFileSync avoids shell-injection because
    // both archPath and destPath are safePath()-resolved.
    const lower = archPath.toLowerCase();
    if (lower.endsWith('.zip')) {
      execFileSync('unzip', ['-o', archPath, '-d', destPath], { stdio: 'pipe', timeout: 120000 });
    } else if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
      execFileSync('tar', ['-xzf', archPath, '-C', destPath], { stdio: 'pipe', timeout: 120000 });
    } else if (lower.endsWith('.tar.bz2') || lower.endsWith('.tbz2')) {
      execFileSync('tar', ['-xjf', archPath, '-C', destPath], { stdio: 'pipe', timeout: 120000 });
    } else if (lower.endsWith('.tar')) {
      execFileSync('tar', ['-xf', archPath, '-C', destPath], { stdio: 'pipe', timeout: 120000 });
    } else {
      return res.json({ success: false, error: 'Unsupported archive format. Supported: .zip, .tar, .tar.gz, .tgz, .tar.bz2.' });
    }
    res.json({ success: true, data: { destination: destRel } });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ── DELETE /api/files/batch — delete multiple paths in one call ──────────────
router.delete('/batch', (req, res) => {
  try {
    const { domain, paths } = req.body;
    if (!Array.isArray(paths) || !paths.length) return res.json({ success: false, error: 'paths array required.' });
    const docRoot = getDomainDocRoot(domain);
    const results = [];
    for (const p of paths) {
      try {
        const t = safePath(docRoot, p);
        const s = fs.statSync(t);
        if (s.isDirectory()) fs.rmSync(t, { recursive: true });
        else fs.unlinkSync(t);
        results.push({ path: p, success: true });
      } catch (e) {
        results.push({ path: p, success: false, error: e.message });
      }
    }
    res.json({ success: true, data: { results, deleted: results.filter(r => r.success).length } });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// ── POST /api/files/move — move multiple paths to a destination dir ──────────
router.post('/move', (req, res) => {
  try {
    const { domain, paths, dest } = req.body;
    if (!Array.isArray(paths) || !paths.length) return res.json({ success: false, error: 'paths array required.' });
    const docRoot  = getDomainDocRoot(domain);
    const destDir  = safePath(docRoot, dest || '');
    if (!fs.existsSync(destDir) || !fs.statSync(destDir).isDirectory()) {
      return res.json({ success: false, error: 'Destination is not a directory.' });
    }
    const results = [];
    for (const p of paths) {
      try {
        const from = safePath(docRoot, p);
        const to   = path.join(destDir, path.basename(from));
        fs.renameSync(from, to);
        results.push({ path: p, success: true });
      } catch (e) {
        results.push({ path: p, success: false, error: e.message });
      }
    }
    res.json({ success: true, data: { results, moved: results.filter(r => r.success).length } });
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
