import { EventEmitter } from 'node:events';
import { logAudit } from './db.js';

export const jobBus = new EventEmitter();
jobBus.setMaxListeners(100);

const queue = [];
const activeDomains = new Set();
const recentJobs = [];
let runningCount = 0;
let seq = 1;

function getConcurrency() {
  const n = Number(process.env.JOB_CONCURRENCY || 2);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 8) : 2;
}

function recordJob(job) {
  recentJobs.unshift(job);
  if (recentJobs.length > 50) recentJobs.pop();
}

export function listJobs() {
  return recentJobs.map(({ fn, ...rest }) => rest);
}

export function enqueueJob({ domain, action, label, fn }) {
  const id = `job-${Date.now()}-${seq++}`;
  const job = {
    id,
    domain: domain || 'global',
    action,
    label,
    status: 'queued',
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    error: '',
    fn,
  };

  recordJob(job);
  queue.push(job);
  emitEvent('job', { id, domain: job.domain, action, label, status: 'queued' });
  pump();
  return id;
}

export function emitEvent(type, payload) {
  jobBus.emit('sse', { type, payload, ts: new Date().toISOString() });
}

function pump() {
  const max = getConcurrency();
  if (runningCount >= max) return;

  for (let i = 0; i < queue.length && runningCount < max; i++) {
    const job = queue[i];
    if (job.domain !== 'global' && activeDomains.has(job.domain)) {
      continue;
    }

    queue.splice(i, 1);
    i--;
    runningCount++;
    if (job.domain !== 'global') activeDomains.add(job.domain);

    runJob(job);
  }
}

async function runJob(job) {
  job.status = 'running';
  job.startedAt = new Date().toISOString();
  emitEvent('job', {
    id: job.id,
    domain: job.domain,
    action: job.action,
    label: job.label,
    status: 'running',
  });

  const log = (line, stream = 'stdout') => {
    emitEvent('log', { id: job.id, domain: job.domain, stream, line });
  };

  try {
    await job.fn(log);
    job.status = 'done';
    job.finishedAt = new Date().toISOString();
    logAudit({ domain: job.domain, action: job.action, status: 'success', details: job.label });
    emitEvent('job', {
      id: job.id,
      domain: job.domain,
      action: job.action,
      label: job.label,
      status: 'done',
    });
  } catch (err) {
    job.status = 'error';
    job.error = err.message || String(err);
    job.finishedAt = new Date().toISOString();
    log(`ERROR: ${job.error}`, 'stderr');
    logAudit({ domain: job.domain, action: job.action, status: 'error', details: job.error });
    emitEvent('job', {
      id: job.id,
      domain: job.domain,
      action: job.action,
      label: job.label,
      status: 'error',
      error: job.error,
    });
  } finally {
    runningCount--;
    if (job.domain !== 'global') activeDomains.delete(job.domain);
    pump();
  }
}
