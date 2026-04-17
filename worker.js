/**
 * ============================================================
 *  SpikeShield Local — Worker (worker.js)
 * ============================================================
 *  Polls the server for jobs in small batches, processes them
 *  sequentially, and reports success or failure with workerId.
 *
 *  Improvements over v1:
 *    • Sends workerId with every request (lock metadata)
 *    • Batch dequeue (BATCH_SIZE jobs per poll, max 5)
 *    • Processes batch sequentially — no dropped work on failure
 *    • Passes workerId to /complete and /fail for event logging
 *    • Timeout on all HTTP requests (avoids hanging forever)
 *
 *  Usage:
 *    node worker.js              → auto-name: worker-<pid>
 *    node worker.js worker-2
 * ============================================================
 */

'use strict';

const http = require('http');

// ─── Config ─────────────────────────────────────────────────
const SERVER_HOST      = '127.0.0.1';
const SERVER_PORT      = parseInt(process.env.PORT || '3000', 10);
const WORKER_ID        = process.argv[2] || `worker-${process.pid}`;
const POLL_INTERVAL_MS = 500;   // back-off delay when queue is empty
const PROCESS_TIME_MS  = 0;     // simulated processing duration
const FAIL_PROBABILITY = 0.10;  // 10% of jobs simulate failure
const BATCH_SIZE       = 20;    // jobs to request per poll (up to 50)
const HTTP_TIMEOUT_MS  = 5000;  // max wait for a server response

// ─── HTTP helper ─────────────────────────────────────────────
/**
 * post(path, data)
 * Lightweight JSON POST over plain http. Rejects on timeout or error.
 */
function post(path, data) {
  return new Promise((resolve, reject) => {
    const body    = JSON.stringify(data);
    const options = {
      hostname: SERVER_HOST,
      port    : SERVER_PORT,
      path,
      method  : 'POST',
      headers : {
        'Content-Type'  : 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = http.request(options, res => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error(`Bad JSON: ${raw}`)); }
      });
    });

    // Abort after HTTP_TIMEOUT_MS so stuck requests don't block the loop
    req.setTimeout(HTTP_TIMEOUT_MS, () => {
      req.destroy(new Error(`HTTP timeout on ${path}`));
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Simulated job processor ──────────────────────────────────
/**
 * processJob(job)
 * Replace this with real business logic.
 * Waits PROCESS_TIME_MS then randomly fails at FAIL_PROBABILITY rate.
 */
function processJob(job) {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (Math.random() < FAIL_PROBABILITY) {
        reject(new Error('Simulated random processing failure'));
      } else {
        resolve();
      }
    }, PROCESS_TIME_MS);
  });
}

// ─── Single job handler ───────────────────────────────────────
/**
 * handleJob(job)
 * Processes one job and sends /complete or /fail to the server.
 * The server is the single source of truth for retry logic and backoff.
 */
async function handleJob(job) {
  try {
    await processJob(job);
    await post('/internal/complete', { id: job.id, workerId: WORKER_ID });
  } catch (err) {
    let failRes;
    try {
      failRes = await post('/internal/fail', { job, error: err.message, workerId: WORKER_ID });
    } catch (netErr) {
      // Can't reach server — job will be recovered by the stuck-job watchdog
      console.error(`[${WORKER_ID}] ⚠️  Failed to report failure for ${job.id}: ${netErr.message}`);
      return;
    }
    if (failRes.requeued) {
      console.warn(`[${WORKER_ID}] 🔁 Job ${job.id} re-queued (retry ${failRes.retries}/3, delay ${failRes.nextRetryIn})`);
    } else {
      console.error(`[${WORKER_ID}] 🗑️  Job ${job.id} permanently discarded.`);
    }
  }
}

// ─── Worker loop ──────────────────────────────────────────────
/**
 * runLoop()
 * Infinite poll: request a batch of BATCH_SIZE jobs, then process
 * each sequentially before polling again.  If the queue is empty,
 * waits POLL_INTERVAL_MS before retrying.
 */
let currentPollInterval = POLL_INTERVAL_MS;
const MAX_POLL_INTERVAL = 5000;

async function runLoop() {
  console.log(`[${WORKER_ID}] 🚀 Started. Server: http://${SERVER_HOST}:${SERVER_PORT} | batch: ${BATCH_SIZE}`);

  while (true) {
    let response;

    // ── 1. Poll for a batch of jobs ──────────────────────────
    try {
      response = await post('/internal/dequeue', {
        workerId: WORKER_ID,
        count   : BATCH_SIZE,
      });
    } catch (err) {
      console.warn(`[${WORKER_ID}] ⚠️  Cannot reach server: ${err.message}. Retrying…`);
      await sleep(currentPollInterval);
      currentPollInterval = Math.min(currentPollInterval * 1.5, MAX_POLL_INTERVAL);
      continue;
    }

    // ── 2. Empty queue — back off ────────────────────────────
    if (response.empty) {
      await sleep(currentPollInterval);
      currentPollInterval = Math.min(currentPollInterval * 1.5, MAX_POLL_INTERVAL);
      continue;
    }

    // Reset backoff on successful poll
    currentPollInterval = POLL_INTERVAL_MS;

    // ── 3. Process batch sequentially ───────────────────────
    // The server already stamped each job with lockedBy/lockedAt.
    // If this process dies mid-batch, the stuck-job watchdog recovers
    // any jobs we didn't ACK via /internal/complete.
    const batch = response.jobs || [];
    for (const job of batch) {
      await handleJob(job);
    }
  }
}

// ─── Utility ──────────────────────────────────────────────────
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ─── Graceful shutdown ────────────────────────────────────────
process.on('SIGINT',  () => { console.log(`\n[${WORKER_ID}] Shutting down.`); process.exit(0); });
process.on('SIGTERM', () => { console.log(`\n[${WORKER_ID}] SIGTERM.`);       process.exit(0); });

// ─── Boot ────────────────────────────────────────────────────
runLoop().catch(err => {
  console.error(`[${WORKER_ID}] Fatal:`, err);
  process.exit(1);
});
