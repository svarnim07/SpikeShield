# SpikeShield Local 🛡️

> A local-only backend that handles load spikes without dropping or duplicating work.  
> **Zero Docker. Zero Redis. Zero PostgreSQL. Runs anywhere Node.js is installed.**

---

## ✨ What It Does

| Feature | How |
|---|---|
| **Backpressure** | Returns `429` when queue exceeds 1 000 jobs |
| **Duplicate prevention** | Blocks re-submission of the same job ID |
| **Crash recovery** | Reloads pending jobs from `queue.json` on restart |
| **Retry logic** | Failed jobs are re-queued up to 3 times |
| **Multiple workers** | Any number of `worker.js` processes can run in parallel |
| **Stress testing** | `spam.js` fires 2 000+ concurrent requests |

---

## 📂 Project Structure

```
hackathon/
├── server.js     — Express API + Queue Manager + Persistence
├── worker.js     — Job processor (run multiple instances)
├── spam.js       — Load test / stress test script
├── queue.json    — Live queue state (auto-managed)
└── package.json  — Dependencies (express, uuid only)
```

---

## 🚀 Quick Start

### 1. Install (one-time)
```bash
npm install
```

### 2. Start the server
```bash
node server.js
```

### 3. Start workers (in separate terminals)
```bash
node worker.js worker-1
node worker.js worker-2
node worker.js worker-3
```

### 4. Send a job
```bash
curl -X POST http://localhost:3000/job \
  -H "Content-Type: application/json" \
  -d '{"payload": {"task": "send-email", "to": "user@example.com"}}'
```

### 5. Run the stress test
```bash
node spam.js              # 2 000 jobs, 20 concurrent
node spam.js 5000 50      # 5 000 jobs, 50 concurrent
node spam.js 2000 20 0.2  # 20% duplicate IDs
```

---

## 📡 API Reference

### `POST /job` — Submit a job
```json
// Request body
{
  "id": "optional-custom-id",   // omit for auto UUID
  "payload": { "any": "data" }
}
```

| Status | Meaning |
|---|---|
| `200 queued` | Job accepted and queued |
| `200 duplicate` | Same ID already in queue/processing |
| `429 busy` | Queue is full — try again later |
| `400` | Missing payload |

### `GET /stats` — System metrics
```json
{
  "queueSize": 42,
  "processingCount": 3,
  "totalReceived": 1000,
  "totalProcessed": 958,
  "totalDropped": 0,
  "timestamp": "2026-04-17T18:00:00.000Z"
}
```

### `GET /health` — Liveness check
```json
{ "ok": true }
```

---

## 🎯 Full Demo Flow

Open **4 terminals**:

```bash
# Terminal 1 — Server
node server.js

# Terminal 2 — Worker A
node worker.js worker-1

# Terminal 3 — Worker B
node worker.js worker-2

# Terminal 4 — Spam + observe stats
node spam.js 2000 20 0.1
# While running, in a 5th terminal:
watch -n 0.5 'curl -s http://localhost:3000/stats | python3 -m json.tool'
```

**What you'll observe:**
- Queue grows rapidly under the spam burst
- Workers drain it steadily at ~2 jobs/second each
- ~10% duplicate rate reports `duplicate` without re-queuing
- When queue hits 1 000 → `429` responses kick in
- Kill worker-1 (`Ctrl+C`) → worker-2 continues processing
- Restart worker-1 → it resumes immediately
- Kill server → restart → pending jobs recovered from `queue.json`

---

## ⚙️ Configuration

All config lives as constants at the top of each file:

| File | Variable | Default | Effect |
|---|---|---|---|
| `server.js` | `MAX_QUEUE_SIZE` | `1000` | Backpressure threshold |
| `server.js` | `SAVE_DEBOUNCE` | `200 ms` | Disk write coalescing |
| `server.js` | `MAX_RETRIES` | `3` | Times a job is retried before discard |
| `worker.js` | `POLL_INTERVAL_MS` | `500 ms` | Poll delay when queue is empty |
| `worker.js` | `PROCESS_TIME_MS` | `500 ms` | Simulated processing duration |
| `worker.js` | `FAIL_PROBABILITY` | `0.10` | Simulated failure rate |
| `spam.js` | positional args | see above | Total / concurrency / duplicate rate |

Change the `PORT` for all processes via environment variable:
```bash
PORT=4000 node server.js
PORT=4000 node worker.js worker-1
PORT=4000 node spam.js
```

---

## 🏗️ Architecture

```
┌──────────────────────────────────────────────────────┐
│  Client (curl / spam.js)                             │
│         │  POST /job                                 │
│         ▼                                            │
│  ┌─────────────┐                                     │
│  │  Express    │ ── duplicate check ──► 200 dup      │
│  │  API Server │ ── queue full ───────► 429 busy     │
│  └──────┬──────┘                                     │
│         │ enqueue()                                  │
│         ▼                                            │
│  ┌─────────────┐    saveQueue()    ┌──────────────┐  │
│  │  In-Memory  │ ◄────────────────► │  queue.json  │  │
│  │  jobs[]     │                   │  (disk sync) │  │
│  └──────┬──────┘                   └──────────────┘  │
│         │ POST /internal/dequeue                     │
│         ▼                                            │
│  ┌────────────────────────────────────┐              │
│  │  Worker 1 │ Worker 2 │ Worker N   │              │
│  │  processJob() → complete / fail   │              │
│  └────────────────────────────────────┘              │
│         │ POST /internal/fail                        │
│         └──► requeueJob() ──► retry (max 3)         │
└──────────────────────────────────────────────────────┘
```

---

## 🧩 Dependencies

```
express  ^4.18.2   — HTTP server
uuid     ^9.0.0    — Auto job ID generation
```

No other runtime dependencies. No build step. No compilation.
