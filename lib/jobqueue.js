'use strict';
/**
 * lib/jobqueue.js — Tiny in-process async job queue.
 *
 * For ops too slow for a request (WordPress install at 60-120s, big backups,
 * etc.) we hand the client a jobId and let it poll /api/jobs/:id.
 *
 * Intentionally in-memory: a panel restart loses in-flight jobs, but jobs
 * are short-running and crash recovery is the kernel's problem. Done jobs
 * live for an hour so the UI can keep showing recent history. Cleanup
 * runs on each enqueue.
 *
 * This module deliberately doesn't persist to the DB — that adds latency
 * for every progress update. If a job's outcome matters across restarts,
 * the job's own callback should write its result wherever it lives in
 * normal life (DB row, file, etc.).
 */

const crypto = require('crypto');

const STATE = { QUEUED: 'queued', RUNNING: 'running', DONE: 'done', FAILED: 'failed', CANCELLED: 'cancelled' };
const RETENTION_MS = 60 * 60 * 1000;   // 1h after finish
const MAX_LOG_LINES = 200;

const _jobs = new Map();   // id → job

function _newId() { return 'job_' + crypto.randomBytes(8).toString('hex'); }

function _cleanup() {
  const cutoff = Date.now() - RETENTION_MS;
  for (const [id, job] of _jobs) {
    if (job.finished_at && new Date(job.finished_at).getTime() < cutoff) _jobs.delete(id);
  }
}

/**
 * Enqueue a job. `fn` is `async (job) => result`. The runner passes the job
 * object so the callback can call `job.progress(percent, message)` /
 * `job.log(line)` to update status.
 *
 * @returns jobId
 */
function enqueue(name, fn, meta = {}) {
  _cleanup();
  const id = _newId();
  const job = {
    id,
    name,
    state:       STATE.QUEUED,
    progress:    0,
    progress_msg: null,
    log:         [],
    result:      null,
    error:       null,
    meta,
    created_at:  new Date().toISOString(),
    started_at:  null,
    finished_at: null,
  };
  // helpers passed to the worker
  job.setProgress = (pct, msg) => {
    job.progress = Math.max(0, Math.min(100, Math.round(pct || 0)));
    if (msg) job.progress_msg = msg;
  };
  job.addLog = (line) => {
    job.log.push(`[${new Date().toISOString()}] ${line}`);
    if (job.log.length > MAX_LOG_LINES) job.log.shift();
  };
  _jobs.set(id, job);

  // Run async, never throw — failures end up as state=failed.
  setImmediate(async () => {
    job.state      = STATE.RUNNING;
    job.started_at = new Date().toISOString();
    try {
      const result = await fn(job);
      job.state    = STATE.DONE;
      job.progress = 100;
      job.result   = result;
    } catch (err) {
      job.state = STATE.FAILED;
      job.error = err?.message || String(err);
    } finally {
      job.finished_at = new Date().toISOString();
    }
  });

  return id;
}

function get(id) {
  const j = _jobs.get(id);
  if (!j) return null;
  // Don't expose the setProgress/addLog functions over JSON
  const { setProgress, addLog, ...safe } = j;
  return safe;
}

function list() {
  return Array.from(_jobs.values()).map(j => {
    const { setProgress, addLog, ...safe } = j;
    return safe;
  }).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

function cancel(id) {
  const j = _jobs.get(id);
  if (!j) return false;
  if (j.state === STATE.RUNNING || j.state === STATE.QUEUED) {
    j.state = STATE.CANCELLED;
    j.finished_at = new Date().toISOString();
    j.error = 'Cancelled by user';
    // Note: we can't actually interrupt a running fn. The worker function is
    // expected to check job.state periodically if it wants cooperative cancel.
    return true;
  }
  return false;
}

module.exports = { enqueue, get, list, cancel, STATE };
