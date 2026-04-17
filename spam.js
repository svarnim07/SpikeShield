/**
 * ============================================================
 *  SpikeShield Local — Stress Test / Spam Script (spam.js)
 * ============================================================
 *  Floods the server with hundreds of jobs to demonstrate:
 *    • Queue growing under load
 *    • Backpressure (429) when queue hits max limit
 *    • Duplicate detection (same ID sent twice)
 *    • Graceful degradation — no jobs are silently lost
 *
 *  Usage:
 *    node spam.js [total] [concurrency] [duplicateRate]
 *
 *  Examples:
 *    node spam.js                   — 2000 jobs, 20 concurrent
 *    node spam.js 500 10            — 500 jobs, 10 concurrent
 *    node spam.js 10000 100 0       — 10000 jobs, 100 concurrent, 0% dupes
 * ============================================================
 */

'use strict';

const http = require('http');

// ─── CLI args ────────────────────────────────────────────────
const TOTAL          = parseInt(process.argv[2] || '2000', 10);
const CONCURRENCY    = parseInt(process.argv[3] || '20', 10);
const DUP_RATE       = parseFloat(process.argv[4] || '0.10');

console.log(`
╔═══════════════════════════════════════════════════╗
║         SpikeShield Local — Spam / Load Test      ║
╠═══════════════════════════════════════════════════╣
║  Total jobs    : ${TOTAL.toString().padEnd(31)} ║
║  Concurrency   : ${CONCURRENCY.toString().padEnd(31)} ║
║  Duplicate rate: ${Math.round(DUP_RATE * 100).toString().padEnd(31)} ║
║  Target        : http://127.0.0.1:3000/job         ║
╚═══════════════════════════════════════════════════╝
`);

let completed = 0;
let index = 0;
let success = 0;
let dupes = 0;
let busy = 0;
let errors = 0;
const startMs = Date.now();
const previousIds = [];

function postJob(id, payload) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ id, payload });
    const req = http.request({
      hostname: '127.0.0.1',
      port: 3000,
      path: '/job',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    
    req.on('error', () => resolve({ status: 0 }));
    req.write(body);
    req.end();
  });
}

async function worker() {
  while (index < TOTAL) {
    const i = index++;
    let id = `job-${startMs}-${i}-${Math.random().toString(36).substring(2, 8)}`;
    
    // Simulate duplicate requests
    if (previousIds.length > 0 && Math.random() < DUP_RATE) {
      id = previousIds[Math.floor(Math.random() * previousIds.length)];
    } else {
      if (previousIds.length < 5000) previousIds.push(id);
    }
    
    const payload = {
      index: i,
      value: Math.floor(Math.random() * 10000),
      description: `Stress test job #${i}`,
      sentAt: new Date().toISOString()
    };
    
    const { status, data } = await postJob(id, payload);
    
    if (status === 200) {
      if (data.includes('duplicate')) dupes++;
      else success++;
    } else if (status === 429) {
      busy++;
    } else {
      errors++;
    }
    
    completed++;
    if (completed % 100 === 0 || completed === TOTAL) {
      process.stdout.write(`\rProgress: ${completed} / ${TOTAL} sent...`);
    }
  }
}

async function main() {
  const promises = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    promises.push(worker());
  }
  
  await Promise.all(promises);
  
  const elapsed = ((Date.now() - startMs) / 1000).toFixed(2);
  console.log(`\n
╔═══════════════════════════════════════════════════╗
║                  Final Results                    ║
╠═══════════════════════════════════════════════════╣
║  Elapsed time  : ${elapsed}s${' '.repeat(Math.max(0, 30 - elapsed.toString().length))}║
║  Total sent    : ${TOTAL.toString().padEnd(31)} ║
║  ✅ Queued     : ${success.toString().padEnd(31)} ║
║  🔁 Duplicate  : ${dupes.toString().padEnd(31)} ║
║  🚫 Busy (429) : ${busy.toString().padEnd(31)} ║
║  ❌ Error      : ${errors.toString().padEnd(31)} ║
╚═══════════════════════════════════════════════════╝
`);
}

main();
