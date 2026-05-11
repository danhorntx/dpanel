#!/usr/bin/env node
'use strict';

/**
 * Sync the duperhuman upstream into DPanel/webmail/ while preserving our
 * DPanel-mode patches.
 *
 * Two file categories live in webmail/.duperhuman-sync.json:
 *   - "ours"     — files we added (additive). Sync ignores them; upstream
 *                  ones would only appear if duperhuman happens to add a file
 *                  with the same path, which we surface as a warning.
 *   - "patched"  — files we modified in-place. Sync does a three-way merge:
 *                  base = upstream at last-synced SHA
 *                  ours = DPanel/webmail/ current
 *                  new  = upstream at target SHA
 *                  Clean merges land silently; conflicts leave standard
 *                  <<<<<<< markers in the file for manual resolution.
 *   - everything else — copied straight from upstream.
 *
 * Usage:
 *   node scripts/sync-duperhuman.js                   # sync to latest main
 *   node scripts/sync-duperhuman.js --dry-run         # show what would change
 *   node scripts/sync-duperhuman.js --target-sha abc  # sync to a specific commit
 *   node scripts/sync-duperhuman.js --skip-build      # skip post-sync build verify
 *
 * On success the manifest's lastSyncedSha advances. On conflict the SHA still
 * advances (so re-running the sync doesn't redo merge work) but lastSyncStatus
 * records "conflicts:<N>" so you remember to clean up before deploying.
 *
 * After a successful sync:
 *   git diff webmail/                  # eyeball what changed
 *   cd webmail && npm run build        # already ran by default, sanity check
 *   git commit -am "chore(webmail): sync duperhuman <new-sha>"
 *   ssh root@<server> "cd /opt/dpanel && bash scripts/deploy-webmail.sh"
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execSync, spawnSync } = require('child_process');

const REPO_ROOT     = path.resolve(__dirname, '..');
const WEBMAIL_DIR   = path.join(REPO_ROOT, 'webmail');
const MANIFEST_PATH = path.join(WEBMAIL_DIR, '.duperhuman-sync.json');

// ── tiny stdout helpers ─────────────────────────────────────────────────────
const c   = { cyan: '\x1b[1;36m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', dim: '\x1b[2m', reset: '\x1b[0m' };
const step = m => console.log(`\n${c.cyan}> ${m}${c.reset}`);
const info = m => console.log(`  ${m}`);
const ok   = m => console.log(`  ${c.green}✓${c.reset} ${m}`);
const warn = m => console.log(`  ${c.yellow}!${c.reset} ${m}`);
const fail = m => console.log(`  ${c.red}✗${c.reset} ${m}`);

// ── arg parsing ─────────────────────────────────────────────────────────────
const args      = process.argv.slice(2);
const dryRun    = args.includes('--dry-run');
const skipBuild = args.includes('--skip-build');
const tsIdx     = args.indexOf('--target-sha');
const targetSha = tsIdx >= 0 ? args[tsIdx + 1] : null;
if (tsIdx >= 0 && !targetSha) {
  console.error('--target-sha requires a value');
  process.exit(2);
}

// ── manifest IO ─────────────────────────────────────────────────────────────
function loadManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    console.error(`Missing manifest: ${MANIFEST_PATH}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
}
function saveManifest(m) {
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(m, null, 2) + '\n');
}

// ── shell helpers ───────────────────────────────────────────────────────────
function sh(cmd, opts = {}) {
  return execSync(cmd, { stdio: 'inherit', ...opts });
}
function shQuiet(cmd) {
  return execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
}

// ── matchers ────────────────────────────────────────────────────────────────
function makeIgnoreCheck(patterns) {
  return p => (patterns || []).some(pat => {
    if (pat.endsWith('/**')) return p.startsWith(pat.slice(0, -2));
    if (pat.endsWith('/*'))  return path.dirname(p) === pat.slice(0, -2);
    return p === pat;
  });
}

// ────────────────────────────────────────────────────────────────────────────
async function main() {
  const manifest = loadManifest();
  const ours    = new Set(manifest.ours    || []);
  const patched = new Set(manifest.patched || []);
  const ignored = makeIgnoreCheck(manifest.ignore);

  const tmpRoot      = fs.mkdtempSync(path.join(os.tmpdir(), 'duperhuman-sync-'));
  const upstreamCur  = path.join(tmpRoot, 'upstream-current');
  const upstreamBase = path.join(tmpRoot, 'upstream-base');

  step('Cloning upstream (target version)');
  sh(`git clone --quiet ${manifest.upstreamRepo} ${upstreamCur}`);
  if (targetSha) {
    sh(`git -C ${upstreamCur} checkout --quiet ${targetSha}`);
  }
  const newSha = shQuiet(`git -C ${upstreamCur} rev-parse HEAD`).trim();
  const newShortSha = newSha.slice(0, 7);

  if (newSha === manifest.lastSyncedSha) {
    ok(`Already at ${newShortSha} — nothing to sync.`);
    return;
  }

  info(`Last synced: ${manifest.lastSyncedSha.slice(0, 7)}`);
  info(`Target SHA:  ${newShortSha}`);

  step('Cloning upstream (base — last synced version, needed for 3-way merge)');
  sh(`git clone --quiet ${manifest.upstreamRepo} ${upstreamBase}`);
  sh(`git -C ${upstreamBase} checkout --quiet ${manifest.lastSyncedSha}`);

  const listFiles = dir =>
    new Set(
      shQuiet(`git -C ${dir} ls-tree -r --name-only HEAD`)
        .trim()
        .split('\n')
        .filter(Boolean)
    );
  const upstreamFiles = listFiles(upstreamCur);
  const baseFiles     = listFiles(upstreamBase);

  step('Synchronising files');

  const stats = { copied: 0, newFiles: 0, merged: 0, conflicts: 0,
                  upstreamRemoved: 0, skipped: 0, ourFilesUpstream: 0 };
  const conflictFiles  = [];
  const ourCollisions  = [];
  const removedFiles   = [];

  for (const file of upstreamFiles) {
    if (ignored(file)) { stats.skipped++; continue; }

    if (ours.has(file)) {
      ourCollisions.push(file);
      stats.ourFilesUpstream++;
      continue;
    }

    const destPath     = path.join(WEBMAIL_DIR, file);
    const upstreamPath = path.join(upstreamCur, file);

    if (patched.has(file)) {
      const basePath = path.join(upstreamBase, file);
      if (!fs.existsSync(destPath)) {
        fail(`patched-file ${file} missing from DPanel — review manually`);
        continue;
      }
      if (!fs.existsSync(basePath)) {
        fail(`base version of ${file} not in upstream@${manifest.lastSyncedSha.slice(0,7)} — likely renamed`);
        continue;
      }

      // git merge-file: 3-way merge; modifies the first arg in place.
      const tempMerge = path.join(tmpRoot, 'merge-' + Buffer.from(file).toString('hex'));
      fs.mkdirSync(path.dirname(tempMerge), { recursive: true });
      fs.copyFileSync(destPath, tempMerge);
      const r = spawnSync('git', ['merge-file', '-L', 'DPanel', '-L', 'upstream-base', '-L', 'upstream-new',
                                   tempMerge, basePath, upstreamPath], { encoding: 'utf8' });

      if (r.status === 0) {
        if (!dryRun) fs.copyFileSync(tempMerge, destPath);
        ok(`merged ${file}`);
        stats.merged++;
      } else if (r.status > 0) {
        if (!dryRun) fs.copyFileSync(tempMerge, destPath);  // leave conflict markers in place
        fail(`CONFLICT in ${file}`);
        conflictFiles.push(file);
        stats.conflicts++;
      } else {
        fail(`merge-file failed for ${file}: ${r.stderr || r.error}`);
      }
      continue;
    }

    // Plain copy
    const newContent = fs.readFileSync(upstreamPath);
    if (!fs.existsSync(destPath)) {
      if (!dryRun) {
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.writeFileSync(destPath, newContent);
      }
      info(`${c.green}+${c.reset} ${file}`);
      stats.newFiles++;
    } else {
      const cur = fs.readFileSync(destPath);
      if (!newContent.equals(cur)) {
        if (!dryRun) fs.writeFileSync(destPath, newContent);
        info(`${c.dim}~${c.reset} ${file}`);
        stats.copied++;
      }
    }
  }

  // Files that existed at last sync but not in target = upstream removals
  for (const file of baseFiles) {
    if (ignored(file) || ours.has(file)) continue;
    if (upstreamFiles.has(file)) continue;
    const destPath = path.join(WEBMAIL_DIR, file);
    if (fs.existsSync(destPath)) {
      removedFiles.push(file);
      stats.upstreamRemoved++;
    }
  }

  // ── report ────────────────────────────────────────────────────────────────
  step('Summary');
  info(`Plain copies (changed):     ${stats.copied}`);
  info(`New upstream files:         ${stats.newFiles}`);
  info(`Patched files merged clean: ${stats.merged}`);
  info(`Patched files w/ conflict:  ${stats.conflicts}`);
  info(`Ignored paths skipped:      ${stats.skipped}`);

  if (ourCollisions.length) {
    console.log(`\n${c.yellow}Upstream now ships a file we treat as ours (review needed):${c.reset}`);
    for (const f of ourCollisions) console.log(`  ${f}`);
  }

  if (removedFiles.length) {
    console.log(`\n${c.yellow}Upstream removed these files — left in place. Delete manually if appropriate:${c.reset}`);
    for (const f of removedFiles) console.log(`  webmail/${f}`);
  }

  if (conflictFiles.length) {
    console.log(`\n${c.red}Conflicts to resolve (search for <<<<<<< inside each file):${c.reset}`);
    for (const f of conflictFiles) console.log(`  webmail/${f}`);
    console.log('\nWorkflow:');
    console.log('  1. Edit each file, pick the correct hunks');
    console.log('  2. Verify: cd webmail && npm run build');
    console.log('  3. Commit + run scripts/deploy-webmail.sh on each server');
  }

  if (dryRun) {
    console.log(`\n${c.dim}(dry run — no files written, manifest unchanged)${c.reset}`);
    return;
  }

  // ── build verification ────────────────────────────────────────────────────
  if (!skipBuild && stats.conflicts === 0) {
    step('Building to verify the merged tree compiles');
    try {
      sh('npm install --silent', { cwd: WEBMAIL_DIR });
      sh('npm run build', { cwd: WEBMAIL_DIR });
      ok('Build passed');
    } catch (e) {
      fail('Build failed — investigate before committing.');
      process.exitCode = 1;
    }
  }

  // ── manifest update ───────────────────────────────────────────────────────
  manifest.lastSyncedSha   = newSha;
  manifest.lastSyncDate    = new Date().toISOString();
  manifest.lastSyncStatus  = stats.conflicts > 0 ? `conflicts:${stats.conflicts}` : 'clean';
  saveManifest(manifest);

  step('Done');
  info(`Manifest now at ${newShortSha} (${manifest.lastSyncStatus})`);
  if (stats.conflicts === 0) {
    info('Next: git diff webmail/, commit, then deploy on each server.');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
