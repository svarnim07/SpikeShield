/**
 * ============================================================
 *  SpikeShield Local — Terminal Monitor (monitor.js)
 * ============================================================
 *  Renders a live ANSI dashboard in the terminal.
 *  Refreshes every second.  No extra dependencies.
 *
 *  Usage:  node monitor.js
 * ============================================================
 */

'use strict';

const http = require('http');

const SERVER_HOST = '127.0.0.1';
const SERVER_PORT = parseInt(process.env.PORT || '3000', 10);
const REFRESH_MS = 1000;
const SPARKLINE = '▁▂▃▄▅▆▇█';

// ─── ANSI helpers ─────────────────────────────────────────────
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  purple: '\x1b[35m',
  blue: '\x1b[34m',
  white: '\x1b[97m',
  bgDark: '\x1b[48;5;234m',
  clearScreen: '\x1b[2J\x1b[H',
};

const clr = (color, text) => `${color}${text}${C.reset}`;
const bold = text => `${C.bold}${text}${C.reset}`;
const dim = text => `${C.dim}${text}${C.reset}`;

// ─── Sparkline ────────────────────────────────────────────────
function sparkline(values, width = 30) {
  if (!values.length) return dim('─'.repeat(width));
  const max = Math.max(...values, 1);
  const bars = values.slice(-width).map(v => {
    const idx = Math.round((v / max) * (SPARKLINE.length - 1));
    return SPARKLINE[idx];
  });
  // colour: green → yellow → red based on last value vs max
  const ratio = values[values.length - 1] / max;
  const color = ratio > 0.8 ? C.red : ratio > 0.5 ? C.yellow : C.green;
  return color + bars.join('') + C.reset;
}

// ─── HTTP helper ─────────────────────────────────────────────
function getStats() {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: SERVER_HOST, port: SERVER_PORT, path: '/stats', method: 'GET' },
      res => {
        let raw = '';
        res.on('data', c => { raw += c; });
        res.on('end', () => { try { resolve(JSON.parse(raw)); } catch (e) { reject(e); } });
      }
    );
    req.on('error', reject);
    req.setTimeout(900, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// ─── Progress bar ─────────────────────────────────────────────
function progressBar(value, max, width = 30) {
  const filled = Math.round(Math.min(value / max, 1) * width);
  const empty = width - filled;
  const ratio = value / max;
  const color = ratio > 0.85 ? C.red : ratio > 0.5 ? C.yellow : C.cyan;
  return color + '█'.repeat(filled) + C.reset + dim('░'.repeat(empty));
}

// ─── State ───────────────────────────────────────────────────
let prevProcessed = null;
const tputHistory = [];   // jobs/sec per tick
const queueHistory = [];
let ticks = 0;
let lastError = null;

// ─── Render ──────────────────────────────────────────────────
function render(data) {
  ticks++;

  // Compute throughput
  let tput = 0;
  if (prevProcessed !== null) {
    tput = data.totalProcessed - prevProcessed;
  }
  prevProcessed = data.totalProcessed;
  tputHistory.push(tput);
  if (tputHistory.length > 60) tputHistory.shift();
  queueHistory.push(data.queueSize);
  if (queueHistory.length > 60) queueHistory.shift();

  const avgTput = tputHistory.length
    ? (tputHistory.reduce((a, b) => a + b, 0) / tputHistory.length).toFixed(2)
    : '0.00';

  const W = 58; // box inner width
  const line = () => dim('─'.repeat(W));
  const row = (l, r) => {
    const lLen = stripAnsi(l).length;
    const rLen = stripAnsi(r).length;
    const pad = Math.max(0, W - lLen - rLen);
    return l + ' '.repeat(pad) + r;
  };

  const statusStr = data.isPaused
    ? clr(C.yellow, '⏸  PAUSED')
    : clr(C.green, '▶  ACTIVE');

  process.stdout.write(C.clearScreen);
  process.stdout.write([
    '',
    clr(C.purple, bold(' ⚡ SpikeShield Local — Terminal Monitor')),
    dim(`    http://${SERVER_HOST}:${SERVER_PORT}   ${new Date().toLocaleTimeString()}    tick #${ticks}`),
    '',
    line(),
    row(
      `  ${bold('Queue')}     ${clr(C.cyan, String(data.queueSize).padStart(6))} jobs`,
      `${statusStr}  `
    ),
    '',
    `  ${progressBar(data.queueSize, data.maxQueueSize, 40)}  ${dim(data.queueSize + '/' + data.maxQueueSize)}`,
    '',
    row(
      `  ${bold('Processing')}  ${clr(C.blue, String(data.processingCount).padStart(6))} workers`,
      `  ${bold('Received')}  ${clr(C.white, String(data.totalReceived).padStart(7))}  `
    ),
    row(
      `  ${bold('Completed')}   ${clr(C.green, String(data.totalProcessed).padStart(6))} jobs`,
      `  ${bold('Dropped')}   ${clr(C.red, String(data.totalDropped).padStart(7))}  `
    ),
    '',
    line(),
    '',
    `  ${bold('Queue size')}  (last ${queueHistory.length}s)`,
    `  ${sparkline(queueHistory, 50)}`,
    '',
    `  ${bold('Throughput')}  (last ${tputHistory.length}s)  avg: ${clr(C.green, avgTput + ' jobs/s')}`,
    `  ${sparkline(tputHistory, 50)}`,
    '',
    line(),
    dim('  Press Ctrl+C to exit.  Browser dashboard → http://localhost:' + SERVER_PORT + '/'),
    '',
  ].join('\n'));
}

function renderError(err) {
  process.stdout.write(C.clearScreen);
  process.stdout.write([
    '',
    clr(C.red, bold(' ⚡ SpikeShield Local — Terminal Monitor')),
    '',
    clr(C.red, `  ✖  Cannot connect to server: ${err.message}`),
    dim(`     Make sure the server is running:  node server.js`),
    '',
  ].join('\n'));
}

// Strip ANSI codes for length calculation
function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

// ─── Poll loop ────────────────────────────────────────────────
async function loop() {
  try {
    const data = await getStats();
    render(data);
  } catch (err) {
    renderError(err);
  }
}

// ─── Start ────────────────────────────────────────────────────
process.stdout.write('\x1b[?25l'); // hide cursor
process.on('exit', () => { process.stdout.write('\x1b[?25h\n'); }); // restore
process.on('SIGINT', () => { process.stdout.write('\x1b[?25h\n'); process.exit(0); });
process.on('SIGTERM', () => { process.stdout.write('\x1b[?25h\n'); process.exit(0); });

loop();
setInterval(loop, REFRESH_MS);
