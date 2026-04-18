/**
 * ============================================================
 *  SpikeShield Local — API Server (server.js)
 * ============================================================
 *  Handles incoming job requests, enforces backpressure (429),
 *  prevents duplicates, and persists the queue to queue.json.
 *
 *  Start with: node server.js [--port 3000] [--workers 2]
 * ============================================================
 */

'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// ─── Config ─────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3000', 10);
const MAX_QUEUE_SIZE = 50000;          // backpressure threshold
const MAX_RETRIES = 3;             // max retry attempts per job
const LOCK_TIMEOUT_MS = 10_000;        // stuck-job threshold (10 s)
const RETRY_BASE_MS = 1_000;         // exponential backoff base delay
const QUEUE_FILE = process.env.VERCEL ? '/tmp/queue.json' : path.join(__dirname, 'queue.json');
const EVENTS_LOG_FILE = process.env.VERCEL ? '/tmp/events.log' : path.join(__dirname, 'events.log');
const SAVE_DEBOUNCE = 300;           // ms — debounce disk writes

// ─── Shared State ────────────────────────────────────────────
/**
 * jobs:          pending FIFO queue. Each job: { id, payload, retries, createdAt }
 * processingJobs: Map<id, job> — jobs locked by a worker.
 *   Lock fields added on dequeue: lockedBy, lockedAt, startTime.
 *   Persisted to queue.json so server restarts recover in-flight jobs.
 */
const jobs = [];         // in-memory FIFO queue
const processingJobs = new Map(); // id → locked job
const processedJobIds = new Set(); // idempotency tracking

let saveTimer = null;
let totalReceived = 0;
let totalProcessed = 0;
let totalDropped = 0;
let stuckRecovered = 0;   // jobs rescued by the stuck-job watchdog
let isPaused = false;

// Latency tracking (startTime → endTime on /internal/complete)
let totalLatencyMs = 0;
let latencyCount = 0;
const recentLatencies = [];
const LATENCY_WINDOW = 1000;

// Throughput tracking
let tputWindow = [];
const serverStartTime = Date.now();

// ─── Rolling stats history (last 60 ticks @ 1 s each) ────────
const HISTORY_MAX = 60;
const history = [];   // [{ ts, queueSize, processingCount, totalProcessed }]

function recordHistory() {
  history.push({
    ts: Date.now(),
    queueSize: jobs.length,
    processingCount: processingJobs.size,
    totalProcessed,
    totalReceived,
    totalDropped,
    stuckRecovered,
  });
  if (history.length > HISTORY_MAX) history.shift();
}
setInterval(recordHistory, 1000);
recordHistory();

// ─── Persistence ─────────────────────────────────────────────

/**
 * rebuildStateFromEvents()
 * Reconstructs state from events.log for robust crash recovery.
 */
function rebuildStateFromEvents() {
  if (!fs.existsSync(EVENTS_LOG_FILE)) return false;
  try {
    const raw = fs.readFileSync(EVENTS_LOG_FILE, 'utf8');
    const lines = raw.trim().split('\n');
    if (lines.length === 0 || !lines[0]) return false;

    const eventJobs = new Map();
    const eventProcessing = new Map();

    for (const line of lines) {
      if (!line) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch (err) {
        console.warn('[queue] Skipping corrupted event log line');
        continue;
      }
      if (ev.type === 'JOB_ENQUEUED') {
        if (!processedJobIds.has(ev.jobId)) eventJobs.set(ev.jobId, ev.job);
      } else if (ev.type === 'JOB_DEQUEUED' || ev.type === 'dequeued') {
        const j = eventJobs.get(ev.jobId);
        if (j) {
          j.lockedBy = ev.workerId;
          j.lockedAt = new Date(ev.ts).getTime();
          j.startTime = j.lockedAt;
          eventJobs.delete(ev.jobId);
          eventProcessing.set(ev.jobId, j);
        }
      } else if (ev.type === 'JOB_COMPLETED' || ev.type === 'completed') {
        eventProcessing.delete(ev.jobId);
        processedJobIds.add(ev.jobId);
      } else if (ev.type === 'JOB_FAILED') {
        eventProcessing.delete(ev.jobId);
      } else if (ev.type === 'JOB_REQUEUED') {
        eventProcessing.delete(ev.jobId);
        if (!processedJobIds.has(ev.jobId)) eventJobs.set(ev.jobId, ev.job);
      } else if (ev.type === 'discarded') {
        eventProcessing.delete(ev.jobId);
        processedJobIds.add(ev.jobId);
      } else if (ev.type === 'QUEUE_FLUSHED') {
        eventJobs.clear();
      } else if (ev.type === 'stuck_recovered') {
        const j = eventProcessing.get(ev.jobId);
        if (j) {
          delete j.lockedBy; delete j.lockedAt; delete j.startTime;
          eventProcessing.delete(ev.jobId);
          eventJobs.set(ev.jobId, j);
        }
      }
    }

    jobs.length = 0;
    processingJobs.clear();
    eventJobs.forEach(j => jobs.push(j));
    eventProcessing.forEach(j => processingJobs.set(j.id, j));

    let recovered = 0;
    processingJobs.forEach((j, id) => {
      delete j.lockedBy; delete j.lockedAt; delete j.startTime;
      jobs.unshift(j);
      processingJobs.delete(id);
      recovered++;
    });
    if (recovered) stuckRecovered += recovered;

    console.log(`[queue] ♻️ Rebuilt from events.log: ${jobs.length} pending jobs.`);
    return true;
  } catch (err) {
    console.error('[queue] Event rebuild failed, falling back to queue.json:', err.message);
    return false;
  }
}

/**
 * loadQueue()
 * Uses event-based recovery first, fallback to queue.json.
 */
function loadQueue() {
  if (rebuildStateFromEvents()) return;
  if (!fs.existsSync(QUEUE_FILE)) {
    console.log('[queue] No queue file — starting fresh.');
    return;
  }
  try {
    const raw = fs.readFileSync(QUEUE_FILE, 'utf8');
    const saved = JSON.parse(raw);
    if (Array.isArray(saved.jobs)) {
      saved.jobs.forEach(j => jobs.push(j));
    }
    // Recover previously-locked (in-progress) jobs → push to front
    if (saved.processingJobs && typeof saved.processingJobs === 'object') {
      let recovered = 0;
      Object.values(saved.processingJobs).forEach(j => {
        delete j.lockedBy; delete j.lockedAt; delete j.startTime;
        jobs.unshift(j);   // high-priority: front of queue
        recovered++;
      });
      if (recovered) {
        stuckRecovered += recovered;
        console.log(`[queue] ♻️  Recovered ${recovered} in-progress job(s) from crash.`);
      }
    }
    console.log(`[queue] Loaded ${jobs.length} pending job(s) from disk.`);
  } catch (err) {
    console.error('[queue] Failed to load queue.json — ignoring:', err.message);
  }
}

/**
 * saveQueue()
 * Persists BOTH pending jobs AND processingJobs to queue.json (debounced).
 * Persisting processingJobs is what enables crash-recovery of locked jobs.
 */
function saveQueue() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const processingSnapshot = {};
    processingJobs.forEach((job, id) => { processingSnapshot[id] = job; });
    const snapshot = {
      savedAt: new Date().toISOString(),
      jobs: [...jobs],
      processingJobs: processingSnapshot,
    };
    fs.writeFile(QUEUE_FILE, JSON.stringify(snapshot, null, 2), err => {
      if (err) console.error('[queue] Failed to write queue.json:', err.message);
    });
  }, SAVE_DEBOUNCE);
}

// ─── Queue Helpers ───────────────────────────────────────────

/** isDuplicate(id) — true if job is pending OR currently locked by a worker */
function isDuplicate(id) {
  if (processedJobIds.has(id)) return true;
  if (processingJobs.has(id)) return true;
  return jobs.some(j => j.id === id);
}

/** enqueue(job) — append to pending queue and persist */
function enqueue(job) {
  if (processedJobIds.has(job.id)) return;
  jobs.push(job);
  saveQueue();
}

/**
 * dequeue(workerId, count)
 * Returns up to `count` ready jobs (skipping those still in backoff window).
 * Each picked job is stamped with lock metadata and moved into processingJobs.
 */
function dequeue(workerId = 'unknown', count = 1) {
  const picked = [];
  const now = Date.now();
  for (let i = 0; i < jobs.length && picked.length < count; i++) {
    const job = jobs[i];
    // Skip jobs still waiting for their backoff delay
    if (job.nextRetryAt && now < job.nextRetryAt) continue;
    jobs.splice(i, 1); i--;
    job.lockedBy = workerId;
    job.lockedAt = now;
    job.startTime = now;
    processingJobs.set(job.id, job);
    picked.push(job);
  }
  if (picked.length > 0) saveQueue();
  return picked;
}

/**
 * requeueJob(job)
 * Re-inserts a failed job with EXPONENTIAL BACKOFF.
 * nextRetryAt = now + RETRY_BASE_MS * 2^(retries-1)
 */
function requeueJob(job) {
  job.retries += 1;
  job.lastFailedAt = new Date().toISOString();
  delete job.lockedBy; delete job.lockedAt; delete job.startTime;
  const delayMs = RETRY_BASE_MS * Math.pow(2, job.retries - 1) + Math.floor(Math.random() * 500);
  job.nextRetryAt = Date.now() + delayMs;
  job.nextRetryIn = `${delayMs}ms`;
  jobs.push(job);
  appendEvent('JOB_REQUEUED', { jobId: job.id, job });
  saveQueue();
}

// ─── Append-only event log ────────────────────────────────────
let eventBuffer = '';
let eventFlushTimer = null;

function rotateLogIfNeeded() {
  if (process.env.VERCEL) return;
  try {
    const stats = fs.statSync(EVENTS_LOG_FILE);
    if (stats.size > 10 * 1024 * 1024) { // 10MB
      fs.copyFileSync(EVENTS_LOG_FILE, EVENTS_LOG_FILE.replace('.log', '.old.log'));
      fs.writeFileSync(EVENTS_LOG_FILE, '');
    }
  } catch (err) { }
}

function flushEvents() {
  if (eventBuffer) {
    const flushData = eventBuffer;
    eventBuffer = '';
    if (!process.env.VERCEL) {
      try {
        fs.appendFileSync(EVENTS_LOG_FILE, flushData);
        rotateLogIfNeeded();
      } catch (err) {
        console.error('[queue] Failed to sync flush events:', err);
      }
    }
  }
}

process.on('exit', flushEvents);
process.on('SIGINT', () => { flushEvents(); process.exit(0); });
process.on('SIGTERM', () => { flushEvents(); process.exit(0); });

/** appendEvent(type, data) — writes one JSON line to events.log */
function appendEvent(type, data) {
  const line = JSON.stringify({ ts: new Date().toISOString(), type, ...data }) + '\n';
  eventBuffer += line;
  if (!eventFlushTimer) {
    eventFlushTimer = setTimeout(() => {
      const flushData = eventBuffer;
      eventBuffer = '';
      eventFlushTimer = null;
      if (flushData) {
        fs.appendFile(EVENTS_LOG_FILE, flushData, (err) => {
          if (err) console.error('[queue] Failed to write event:', err);
          else rotateLogIfNeeded();
        });
      }
    }, 50);
  }
}

// ─── Stuck-job watchdog ───────────────────────────────────────
/**
 * recoverStuckJobs()
 * Runs every 5 seconds.  Any job locked longer than LOCK_TIMEOUT_MS
 * is assumed to belong to a dead worker and is re-queued at the front.
 */
function recoverStuckJobs() {
  const now = Date.now();
  processingJobs.forEach((job, id) => {
    if (now - job.lockedAt > LOCK_TIMEOUT_MS) {
      processingJobs.delete(id);
      console.warn(`[watchdog] ⏰ Job ${id} stuck >${LOCK_TIMEOUT_MS}ms (worker: ${job.lockedBy}) — re-queuing.`);
      appendEvent('stuck_recovered', { jobId: id, lockedBy: job.lockedBy });
      delete job.lockedBy; delete job.lockedAt; delete job.startTime;
      jobs.unshift(job);
      stuckRecovered++;
      saveQueue();
    }
  });
}
setInterval(recoverStuckJobs, 5_000);

// ─── Express App ─────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '100kb' }));

// ── Middleware: request logger (skip high-frequency internal calls) ──
const SILENT_PATHS = new Set(['/internal/dequeue', '/internal/complete', '/internal/fail', '/stats', '/health']);
app.use((req, _res, next) => {
  if (!SILENT_PATHS.has(req.path)) console.log(`[http] ${req.method} ${req.path}`);
  next();
});

// ── POST /job — Submit a new job ──────────────────────────────
/**
 * Body (JSON):
 *   id      {string} optional — auto-generated if omitted
 *   payload {any}    required — arbitrary job data
 *
 * Responses:
 *   200  { status: 'queued',     job }       — job accepted
 *   429  { status: 'busy',       ... }       — queue full
 *   409  { status: 'duplicate',  ... }       — already enqueued
 *   400  { error: '...' }                    — bad request
 */
app.post('/job', (req, res) => {
  totalReceived++;

  // ── Backpressure: refuse when queue is full ─────────────────
  if (jobs.length >= MAX_QUEUE_SIZE) {
    totalDropped++;
    return res.status(429).json({
      status: 'busy',
      message: `Queue limit reached (${MAX_QUEUE_SIZE} jobs). Try again later.`,
      queueSize: jobs.length,
    });
  }

  const { id: clientId, payload } = req.body;

  if (payload === undefined) {
    return res.status(400).json({ error: 'payload is required.' });
  }

  // ── Generate or use provided ID ──────────────────────────────
  const jobId = (typeof clientId === 'string' && clientId.trim())
    ? clientId.trim()
    : uuidv4();

  // ── Duplicate prevention ─────────────────────────────────────
  if (isDuplicate(jobId)) {
    return res.status(200).json({
      status: 'duplicate',
      message: `Job "${jobId}" is already queued.`,
      jobId,
    });
  }

  // ── Build and enqueue job ────────────────────────────────────
  const job = {
    id: jobId,
    payload,
    retries: 0,
    createdAt: new Date().toISOString(),
  };
  enqueue(job);
  appendEvent('JOB_ENQUEUED', {
    jobId: job.id,
    job
  });

  return res.status(200).json({ status: 'queued', job });
});

/**
 * POST /internal/bulk-job
 * Instantly injects N jobs into the queue to simulate massive traffic spikes
 * without hitting Vercel/browser rate limits.
 */
app.post('/internal/bulk-job', (req, res) => {
  const { count } = req.body;
  const num = Math.min(count || 1000, MAX_QUEUE_SIZE);
  let queued = 0;
  let busy = 0;

  for (let i = 0; i < num; i++) {
    const id = `bulk-${Date.now()}-${i}`;
    if (jobs.length >= MAX_QUEUE_SIZE) {
      totalDropped++;
      busy++;
    } else {
      jobs.push({ id, payload: { source: 'bulk', i }, retries: 0, createdAt: new Date().toISOString() });
      totalReceived++;
      queued++;
    }
  }
  
  saveQueue();
  appendEvent('BULK_RECEIVED', { count: num, queued, dropped: busy });
  res.json({ queued, busy, status: 'ok' });
});

// ── GET /stats — Current system stats + rolling history ─────────
function getP95Latency() {
  if (recentLatencies.length === 0) return null;
  const sorted = [...recentLatencies].sort((a, b) => a - b);
  const idx = Math.floor(sorted.length * 0.95);
  return sorted[idx];
}

function getThroughput() {
  const now = Date.now();
  tputWindow = tputWindow.filter(ts => now - ts < 60000);
  const uptimeSecs = Math.max(1, (now - serverStartTime) / 1000);
  const windowSecs = Math.min(uptimeSecs, 60);
  return (tputWindow.length / windowSecs).toFixed(2);
}

app.get('/stats', (_req, res) => {
  const avgLatencyMs = latencyCount > 0 ? Math.round(totalLatencyMs / latencyCount) : null;
  res.json({
    queueSize: jobs.length,
    processingCount: processingJobs.size,
    totalReceived,
    totalProcessed,
    totalDropped,
    stuckRecovered,
    avgLatencyMs,
    p95LatencyMs: getP95Latency(),
    throughput: parseFloat(getThroughput()),
    isPaused,
    maxQueueSize: MAX_QUEUE_SIZE,
    timestamp: new Date().toISOString(),
    history,
  });
});

// ── GET /health ───────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true }));

// ─── Admin Endpoints ──────────────────────────────────────────

/**
 * POST /admin/pause   — Stop workers from picking up new jobs.
 * POST /admin/resume  — Re-enable job pickup.
 */
app.post('/admin/pause', (_req, res) => {
  isPaused = true;
  console.log('[admin] ⏸  Queue PAUSED');
  res.json({ ok: true, isPaused });
});

app.post('/admin/resume', (_req, res) => {
  isPaused = false;
  console.log('[admin] ▶️  Queue RESUMED');
  res.json({ ok: true, isPaused });
});

/**
 * DELETE /admin/flush — Discard all pending (not processing) jobs.
 */
app.delete('/admin/flush', (_req, res) => {
  const count = jobs.length;
  jobs.length = 0;    // drain in-place
  totalDropped += count;
  appendEvent('QUEUE_FLUSHED', { flushedCount: count });
  saveQueue();
  console.log(`[admin] 🗑  Flushed ${count} pending jobs.`);
  res.json({ ok: true, flushed: count });
});

/**
 * GET /admin/job/:id  — Look up a job by ID.
 * Returns its current status: queued | processing | completed | not_found
 */
app.get('/admin/job/:id', (req, res) => {
  const { id } = req.params;
  const pJob = processingJobs.get(id);
  if (pJob) return res.json({ id, status: 'processing', job: pJob });
  const job = jobs.find(j => j.id === id);
  if (job) return res.json({ id, status: 'queued', job });
  if (processedJobIds.has(id)) return res.json({ id, status: 'completed' });
  res.status(404).json({ id, status: 'not_found' });
});

// ─── Live Dashboard ───────────────────────────────────────────
// Single-file HTML dashboard served from GET /
// Polls /stats every second and renders live charts + controls.
app.get('/', (_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(getDashboardHTML());
});

function getDashboardHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SpikeShield Local — Dashboard</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');

  :root {
    
    --radius:  12px;
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    background: var(--bg);
    color: var(--text);
    font-family: 'Inter', sans-serif;
    min-height: 100vh;
    padding: 24px;
  }

  header {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-bottom: 28px;
  }

  .logo {
    width: 40px; height: 40px;
    background: linear-gradient(135deg, var(--accent), #a855f7);
    border-radius: 10px;
    display: flex; align-items: center; justify-content: center;
    font-size: 20px;
  }

  header h1 { font-size: 1.35rem; font-weight: 600; }
  header span { font-size: .8rem; color: var(--muted); margin-left: 6px; }

  .badge {
    margin-left: auto;
    padding: 4px 12px;
    border-radius: 20px;
    font-size: .75rem;
    font-weight: 600;
    letter-spacing: .5px;
    text-transform: uppercase;
    transition: background .3s, color .3s;
  }
  .badge.active  { background: #16a34a22; color: var(--green); border: 1px solid #16a34a55; }
  .badge.paused  { background: #f59e0b22; color: var(--yellow); border: 1px solid #f59e0b55; }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
    gap: 16px;
    margin-bottom: 24px;
  }

  .stat-card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 18px 20px;
    position: relative;
    overflow: hidden;
    transition: transform .15s;
  }
  .stat-card:hover { transform: translateY(-2px); }
  .stat-card::before {
    content: '';
    position: absolute; top: 0; left: 0; right: 0; height: 3px;
    background: var(--accent-c, var(--accent));
  }
  .stat-card .label { font-size: .72rem; color: var(--muted); text-transform: uppercase; letter-spacing: .8px; margin-bottom: 8px; }
  .stat-card .value { font-size: 2rem; font-weight: 700; font-family: 'JetBrains Mono', monospace; line-height: 1; }
  .stat-card .sub   { font-size: .72rem; color: var(--muted); margin-top: 6px; }

  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 24px; }
  @media (max-width: 780px) { .row { grid-template-columns: 1fr; } }

  .panel {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 20px;
  }
  .panel h2 { font-size: .85rem; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: .8px; margin-bottom: 16px; }

  canvas { width: 100% !important; height: 160px !important; display: block; }

  .bar-track {
    background: var(--border);
    border-radius: 6px;
    height: 10px;
    overflow: hidden;
    margin-top: 8px;
  }
  .bar-fill {
    height: 100%;
    border-radius: 6px;
    background: linear-gradient(90deg, var(--accent), #a855f7);
    transition: width .4s ease;
  }

  .controls { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 24px; }

  button {
    padding: 9px 18px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--card);
    color: var(--text);
    font-size: .82rem;
    font-weight: 500;
    font-family: 'Inter', sans-serif;
    cursor: pointer;
    transition: background .15s, transform .1s, border-color .15s;
    display: flex; align-items: center; gap: 6px;
  }
  button:hover { background: var(--border); transform: translateY(-1px); }
  button:active { transform: translateY(0); }
  button.danger { border-color: #ef444455; color: var(--red); }
  button.danger:hover { background: #ef444415; }
  button.primary { border-color: var(--accent); color: var(--accent); }
  button.primary:hover { background: #6c63ff18; }
  button.success { border-color: #22c55e55; color: var(--green); }
  button.success:hover { background: #22c55e15; }

  .log {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 16px;
    height: 200px;
    overflow-y: auto;
    font-family: 'JetBrains Mono', monospace;
    font-size: .75rem;
    line-height: 1.7;
    color: var(--muted);
  }
  .log .entry { animation: fadeIn .2s ease; }
  .log .entry.ok  { color: var(--green); }
  .log .entry.err { color: var(--red); }
  .log .entry.warn { color: var(--yellow); }
  @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }

  #lookup-row { display: flex; gap: 8px; margin-top: 8px; }
  #lookup-row input {
    flex: 1;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text);
    padding: 8px 12px;
    font-family: 'JetBrains Mono', monospace;
    font-size: .82rem;
    outline: none;
  }
  #lookup-row input:focus { border-color: var(--accent); }
  #lookup-result {
    margin-top: 10px;
    font-family: 'JetBrains Mono', monospace;
    font-size: .75rem;
    color: var(--blue);
    white-space: pre-wrap;
    word-break: break-all;
    max-height: 120px;
    overflow-y: auto;
  }

  .ts { color: var(--muted); font-size: .72rem; margin-left: auto; }
</style>
</head>
<body>

<header>
  <div class="logo">⚡</div>
  <div>
    <h1>SpikeShield Local</h1>
    <span>Local queue dashboard — live</span>
  </div>
  <div class="badge active" id="status-badge">Active</div>
</header>

<!-- KPI cards -->
<div class="grid">
  <div class="stat-card" style="--accent-c: #6c63ff">
    <div class="label">Queue Size</div>
    <div class="value" id="s-queue">—</div>
    <div class="sub">pending jobs</div>
    <div class="bar-track"><div class="bar-fill" id="s-bar" style="width:0%"></div></div>
  </div>
  <div class="stat-card" style="--accent-c: #38bdf8">
    <div class="label">Processing</div>
    <div class="value" id="s-processing">—</div>
    <div class="sub">active workers</div>
  </div>
  <div class="stat-card" style="--accent-c: #22c55e">
    <div class="label">Completed</div>
    <div class="value" id="s-done">—</div>
    <div class="sub">total processed</div>
  </div>
  <div class="stat-card" style="--accent-c: #f59e0b">
    <div class="label">Received</div>
    <div class="value" id="s-recv">—</div>
    <div class="sub">total submitted</div>
  </div>
  <div class="stat-card" style="--accent-c: #ef4444">
    <div class="label">Dropped / 429</div>
    <div class="value" id="s-drop">—</div>
    <div class="sub">rejected jobs</div>
  </div>
  <div class="stat-card" style="--accent-c: #a855f7">
    <div class="label">Throughput</div>
    <div class="value" id="s-tput">—</div>
    <div class="sub">jobs/sec (1m avg)</div>
  </div>
</div>

<!-- Charts -->
<div class="row">
  <div class="panel">
    <h2>Queue Size — last 60 s</h2>
    <canvas id="chart-queue"></canvas>
  </div>
  <div class="panel">
    <h2>Throughput — processed/s</h2>
    <canvas id="chart-tput"></canvas>
  </div>
</div>

<!-- Controls -->
<div class="controls">
  <button class="success" id="btn-resume" onclick="adminAction('resume')">▶ Resume</button>
  <button class="warn"    id="btn-pause"  onclick="adminAction('pause')">⏸ Pause</button>
  <button class="danger"  id="btn-flush"  onclick="adminFlush()">🗑 Flush Queue</button>
  <button class="primary"                 onclick="sendTestJob()">＋ Send Test Job</button>
  <button class="primary" id="btn-stress-1k" onclick="sendStressRequests(1000, 'btn-stress-1k')">🚀 Send 1000 Requests</button>
  <button class="primary" id="btn-stress-10k" onclick="sendStressRequests(10000, 'btn-stress-10k')">🚀 Send 10k Requests</button>
  <span class="ts" id="last-update"></span>
</div>

<!-- Log -->
<div class="panel" style="margin-bottom:24px">
  <h2>Event Log</h2>
  <div class="log" id="log"></div>
</div>

<!-- Job Lookup -->
<div class="panel">
  <h2>Job Lookup</h2>
  <div id="lookup-row">
    <input id="lookup-id" placeholder="Enter job ID…" />
    <button onclick="lookupJob()">🔍 Find</button>
  </div>
  <div id="lookup-result"></div>
</div>

<script>
// ── Mini canvas chart helper ───────────────────────────────────
function drawChart(canvas, data, color) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width  = canvas.offsetWidth  * dpr;
  canvas.height = canvas.offsetHeight * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const W = canvas.offsetWidth, H = canvas.offsetHeight;
  ctx.clearRect(0, 0, W, H);

  if (data.length < 2) return;

  const max = Math.max(...data, 1);
  const pts = data.map((v, i) => ({
    x: (i / (data.length - 1)) * W,
    y: H - (v / max) * (H - 8) - 4,
  }));

  // Fill
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, color + '55');
  grad.addColorStop(1, color + '00');
  ctx.beginPath();
  ctx.moveTo(pts[0].x, H);
  pts.forEach(p => ctx.lineTo(p.x, p.y));
  ctx.lineTo(pts[pts.length - 1].x, H);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Line
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  pts.forEach(p => ctx.lineTo(p.x, p.y));
  ctx.strokeStyle = color;
  ctx.lineWidth   = 2;
  ctx.lineJoin    = 'round';
  ctx.stroke();

  // Last value label
  const last = pts[pts.length - 1];
  ctx.fillStyle = color;
  ctx.font = '500 11px JetBrains Mono, monospace';
  ctx.fillText(data[data.length - 1], last.x - 4, Math.max(last.y - 6, 12));
}

// ── State ─────────────────────────────────────────────────────
let prevProcessed  = null;
let tputHistory    = [];

// ── Polling ───────────────────────────────────────────────────
async function poll() {
  try {
    const res  = await fetch('/stats');
    const data = await res.json();

    // KPI
    document.getElementById('s-queue').textContent      = data.queueSize;
    document.getElementById('s-processing').textContent = data.processingCount;
    document.getElementById('s-done').textContent       = data.totalProcessed;
    document.getElementById('s-recv').textContent       = data.totalReceived;
    document.getElementById('s-drop').textContent       = data.totalDropped;

    // Queue bar
    const pct = Math.min((data.queueSize / data.maxQueueSize) * 100, 100).toFixed(1);
    document.getElementById('s-bar').style.width = pct + '%';

    // Throughput
    if (prevProcessed !== null) {
      tputHistory.push(data.totalProcessed - prevProcessed);
      if (tputHistory.length > 60) tputHistory.shift();
    }
    prevProcessed = data.totalProcessed;
    const avg = tputHistory.length
      ? (tputHistory.reduce((a, b) => a + b, 0) / tputHistory.length).toFixed(2)
      : '—';
    document.getElementById('s-tput').textContent = avg;

    // Charts
    const queueVals = data.history.map(h => h.queueSize);
    drawChart(document.getElementById('chart-queue'), queueVals, '#6c63ff');
    drawChart(document.getElementById('chart-tput'),  tputHistory,  '#22c55e');

    // Status badge
    const badge = document.getElementById('status-badge');
    badge.textContent  = data.isPaused ? 'Paused' : 'Active';
    badge.className    = 'badge ' + (data.isPaused ? 'paused' : 'active');

    document.getElementById('last-update').textContent = 'Updated ' + new Date().toLocaleTimeString();
  } catch (_) {
    appendLog('⚠ Cannot reach server.', 'err');
  }
}

setInterval(poll, 1000);
poll();

// ── Admin actions ─────────────────────────────────────────────
async function adminAction(action) {
  const method = action === 'flush' ? 'DELETE' : 'POST';
  const res  = await fetch('/admin/' + action, { method });
  const data = await res.json();
  appendLog('Admin: ' + action + ' → ' + JSON.stringify(data), 'ok');
}

let flushConfirming = false;
let flushTimer = null;
async function adminFlush() {
  const btn = document.getElementById('btn-flush');
  if (!flushConfirming) {
    btn.textContent = '🗑 Sure? Click again';
    btn.style.background = '#ef444433';
    flushConfirming = true;
    flushTimer = setTimeout(() => {
      flushConfirming = false;
      btn.textContent = '🗑 Flush Queue';
      btn.style.background = '';
    }, 3000);
    return;
  }
  clearTimeout(flushTimer);
  flushConfirming = false;
  btn.textContent = '🗑 Flush Queue';
  btn.style.background = '';

  const res  = await fetch('/admin/flush', { method: 'DELETE' });
  const data = await res.json();
  appendLog('🗑 Flushed ' + data.flushed + ' jobs.', 'warn');
}

async function sendTestJob() {
  const res  = await fetch('/job', {
    method : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body   : JSON.stringify({ payload: { source: 'dashboard', sentAt: new Date().toISOString() } }),
  });
  const data = await res.json();
  appendLog('Test job → ' + data.status + ' (' + (data.job || data).id + ')', data.status === 'queued' ? 'ok' : 'warn');
}

async function sendStressRequests(total, btnId) {
  const btn = document.getElementById(btnId);
  btn.disabled = true;
  btn.style.opacity = '0.7';

  appendLog('🚀 Triggering massive ' + total + ' request spike...', 'warn');
  btn.textContent = '🚀 Sending ' + total + '...';

  try {
    const res = await fetch('/internal/bulk-job', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count: total })
    });
    const data = await res.json();
    appendLog('✅ Massive spike complete: ' + data.queued + ' queued, ' + data.busy + ' dropped.', 'info');
  } catch (err) {
    appendLog('❌ Failed to send bulk jobs: ' + err.message, 'error');
  }

  btn.textContent = '🚀 Send ' + (total === 10000 ? '10k' : total) + ' Requests';
  btn.style.opacity = '1';
  btn.disabled = false;
}

async function lookupJob() {
  const id = document.getElementById('lookup-id').value.trim();
  if (!id) return;
  const res  = await fetch('/admin/job/' + encodeURIComponent(id));
  const data = await res.json();
  document.getElementById('lookup-result').textContent = JSON.stringify(data, null, 2);
}

// ── Event log ─────────────────────────────────────────────────
function appendLog(msg, cls = '') {
  const log  = document.getElementById('log');
  const div  = document.createElement('div');
  div.className = 'entry ' + cls;
  div.textContent = '[' + new Date().toLocaleTimeString() + '] ' + msg;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  if (log.children.length > 200) log.removeChild(log.firstChild);
}

// Enter key on lookup input
document.getElementById('lookup-id').addEventListener('keydown', e => {
  if (e.key === 'Enter') lookupJob();
});
</script>
</body>
</html>`;
}

// ─── Internal API for Workers ─────────────────────────────────
// Workers call these JSON endpoints over localhost to coordinate.

/**
 * POST /internal/dequeue
 * Body (optional): { workerId, count }
 *   workerId  identifies the calling worker (stored in lock metadata)
 *   count     max jobs to return in one batch (default 1, max 5)
 * Returns { jobs: [...] } or { empty: true }
 */
app.post('/internal/dequeue', (req, res) => {
  if (isPaused) return res.json({ empty: true, paused: true });
  const workerId = req.body.workerId || 'unknown';
  const count = Math.min(parseInt(req.body.count || '1', 10), 50);
  const batch = dequeue(workerId, count);
  if (batch.length === 0) return res.json({ empty: true });
  batch.forEach(j => appendEvent('JOB_DEQUEUED', { jobId: j.id, workerId }));
  res.json({ jobs: batch });
});

/**
 * POST /internal/complete
 * Worker reports successful processing.  Job is removed only here
 * (ACK safety: if worker crashes before calling this, the stuck-job
 * watchdog will recover the job automatically).
 * Body: { id, workerId }
 */
app.post('/internal/complete', (req, res) => {
  const { id, workerId } = req.body;
  const job = processingJobs.get(id);
  appendEvent('JOB_COMPLETED', { jobId: id, workerId });
  processingJobs.delete(id);
  saveQueue();
  totalProcessed++;
  const now = Date.now();
  if (job && job.startTime) {
    const lat = now - job.startTime;
    totalLatencyMs += lat;
    latencyCount++;
    recentLatencies.push(lat);
    if (recentLatencies.length > LATENCY_WINDOW) recentLatencies.shift();
  }
  tputWindow.push(now);
  processedJobIds.add(id);
  res.json({ ok: true });
});

/**
 * POST /internal/fail
 * Worker reports a failed job.  Server decides whether to retry
 * or discard based on retry limit.
 * Body: { job, error }
 */
app.post('/internal/fail', (req, res) => {
  const { job, error, workerId } = req.body;
  processingJobs.delete(job.id);
  console.warn(`[worker] ❌ Job ${job.id} failed (attempt ${job.retries + 1}): ${error}`);
  appendEvent('JOB_FAILED', { jobId: job.id, workerId, error, retries: job.retries });
  if (job.retries < MAX_RETRIES) {
    requeueJob(job);
    console.log(`[worker] 🔁 Job ${job.id} re-queued with ${job.nextRetryIn} backoff (retry ${job.retries}/${MAX_RETRIES})`);
    return res.json({ requeued: true, retries: job.retries, nextRetryIn: job.nextRetryIn });
  }
  totalDropped++;
  saveQueue();
  console.error(`[worker] 🗑️  Job ${job.id} discarded after ${MAX_RETRIES} failures.`);
  appendEvent('discarded', { jobId: job.id, workerId });
  res.json({ requeued: false, discarded: true });
});

// ─── Start Server ─────────────────────────────────────────────
loadQueue();   // recover persisted jobs before accepting traffic

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════╗
║          SpikeShield Local — Server              ║
╠══════════════════════════════════════════════════╣
║  API  + Dashboard : http://localhost:${PORT}        ║
║  Live Dashboard   : http://localhost:${PORT}/        ║
║  Stats            : http://localhost:${PORT}/stats   ║
║  Max queue        : ${MAX_QUEUE_SIZE} jobs                    ║
║  Persistence      : ${process.env.VERCEL ? '/tmp/' : ''}queue.json                   ║
╚══════════════════════════════════════════════════╝
`);
  });
}

module.exports = app;
