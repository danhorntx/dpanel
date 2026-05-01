'use strict';
const { execSync } = require('child_process');
const { logAction } = require('./shell');

const CRON_USER = 'www-data';

function parseLine(line) {
  if (!line || line.startsWith('#')) return null;
  const parts = line.trim().split(/\s+/);
  if (parts.length < 6) return null;
  const schedule = parts.slice(0, 5).join(' ');
  const command  = parts.slice(5).join(' ');
  return { schedule, command, raw: line };
}

function list() {
  try {
    const raw = execSync(`crontab -u ${CRON_USER} -l 2>/dev/null`, { encoding: 'utf8' });
    return raw.split('\n').map(parseLine).filter(Boolean);
  } catch (_) { return []; }
}

function add(schedule, command) {
  // Basic validation
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('Schedule must have 5 fields (min hour dom month dow).');
  if (!command || command.trim().length < 2) throw new Error('Command is required.');

  const existing = getRaw();
  const newLine  = `${schedule.trim()} ${command.trim()}`;
  const updated  = existing ? existing.trimEnd() + '\n' + newLine + '\n' : newLine + '\n';
  setCrontab(updated);
  logAction('cron:add', CRON_USER, newLine);
}

function remove(index) {
  const lines = getRaw().split('\n');
  let cronLines = lines.map(parseLine);
  let count = 0;
  const filtered = lines.filter(line => {
    if (!line.trim() || line.startsWith('#')) return true;
    return count++ !== index;
  });
  setCrontab(filtered.join('\n') + '\n');
  logAction('cron:remove', CRON_USER, `index ${index}`);
}

function getRaw() {
  try { return execSync(`crontab -u ${CRON_USER} -l 2>/dev/null`, { encoding: 'utf8' }); }
  catch (_) { return ''; }
}

function setCrontab(content) {
  const { writeFileSync, unlinkSync } = require('fs');
  const tmp = `/tmp/dpanel-cron-${Date.now()}`;
  writeFileSync(tmp, content);
  execSync(`crontab -u ${CRON_USER} ${tmp}`);
  unlinkSync(tmp);
}

// Human-readable schedule description
function describeSchedule(sched) {
  const presets = {
    '* * * * *':       'Every minute',
    '*/5 * * * *':     'Every 5 minutes',
    '*/15 * * * *':    'Every 15 minutes',
    '*/30 * * * *':    'Every 30 minutes',
    '0 * * * *':       'Every hour',
    '0 */6 * * *':     'Every 6 hours',
    '0 0 * * *':       'Daily at midnight',
    '0 3 * * *':       'Daily at 3am',
    '0 0 * * 0':       'Weekly (Sunday midnight)',
    '0 0 1 * *':       'Monthly (1st at midnight)',
  };
  return presets[sched] || sched;
}

module.exports = { list, add, remove, describeSchedule };
