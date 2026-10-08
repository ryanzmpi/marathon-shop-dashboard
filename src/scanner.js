// Keeps an up-to-date picture of open jobs by walking job numbers through the listener.
//
// The listener has no "list open jobs" command, so:
//   1. Find the newest job number (or use START_JOBNO).
//   2. Backfill: check the last BACKFILL_COUNT numbers once to find older jobs that are still open.
//   3. Every REFRESH_SECONDS: re-check every known open job, and probe upward for new job numbers.
// When an open job disappears, we look it up in History to record it as invoiced (for sales totals).
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { getJob, stats } = require('./listener');

const STATE_FILE = path.join(cfg.dataDir, 'state.json');

const state = {
  version: 1,
  maxJobNo: 0,
  open: {}, // jobNo -> job
  invoiced: {}, // jobNo -> slim job (recent only)
  backfill: null, // { from, to, next, done }
  lastCycleAt: null,
  lastCycleMs: null,
  cycles: 0,
  startedAt: new Date().toISOString(),
  phase: 'starting',
};

function load() {
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (saved.version === 1) Object.assign(state, saved, { phase: 'starting', startedAt: state.startedAt });
    console.log(`[scan] loaded cache: ${Object.keys(state.open).length} open jobs, newest #${state.maxJobNo}`);
  } catch {
    console.log('[scan] no cache found, starting fresh');
  }
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(cfg.dataDir, { recursive: true });
      const tmp = STATE_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, STATE_FILE);
    } catch (err) {
      console.error('[scan] could not save cache:', err.message);
    }
  }, 500);
}

const todayLocal = () => new Intl.DateTimeFormat('en-CA', { timeZone: cfg.timeZone }).format(new Date());
function daysAgo(d) {
  if (!d) return Infinity;
  return (Date.parse(todayLocal()) - Date.parse(d)) / 86400000;
}

function slimInvoiced(job) {
  return {
    jobNo: job.jobNo, title: job.title, customer: job.customer, csrNo: job.csrNo, repNo: job.repNo,
    dateIn: job.dateIn, dateDue: job.dateDue, dateShipped: job.dateShipped, subtotal: job.subtotal, total: job.total,
  };
}
function recordInvoiced(job) {
  if (daysAgo(job.dateShipped || job.dateIn) <= cfg.invoicedKeepDays) state.invoiced[job.jobNo] = slimInvoiced(job);
}

// Does this job number exist at all (open or invoiced)? Records what it finds.
async function probe(jobNo, { recordHistory = true } = {}) {
  const open = await getJob('Order', jobNo);
  if (open) { state.open[jobNo] = { ...open, seenAt: new Date().toISOString() }; return true; }
  const hist = await getJob('History', jobNo);
  if (hist) { if (recordHistory) recordInvoiced(hist); return true; }
  return false;
}

async function exists(jobNo) {
  const [a, b] = await Promise.all([getJob('Order', jobNo), getJob('History', jobNo)]);
  return !!(a || b);
}

// Fallback when START_JOBNO isn't set: sample job numbers on a 5% geometric grid and take the
// largest one that exists; findNewJobs() then walks forward to the true newest number.
// (Setting START_JOBNO to any recent job number is faster and more reliable.)
async function discoverNewest() {
  const points = [];
  for (let x = 100; x < 50_000_000; x = Math.ceil(x * 1.05)) points.push(x);
  const hits = await Promise.all(points.map((x) => exists(x).catch(() => false)));
  const found = points.filter((_, i) => hits[i]);
  if (!found.length) throw new Error('Could not find any jobs — set START_JOBNO to a recent job number');
  return Math.max(...found);
}

// Check the next GAP_LIMIT numbers past the newest known job (in parallel). If any exist,
// move the marker forward and look again; stop when a whole window is empty.
async function findNewJobs() {
  for (;;) {
    const base = state.maxJobNo;
    const nums = Array.from({ length: cfg.gapLimit }, (_, i) => base + 1 + i);
    const hits = await Promise.all(nums.map((x) => probe(x).catch(() => false)));
    const found = nums.filter((_, i) => hits[i]);
    if (!found.length) return;
    state.maxJobNo = Math.max(...found);
  }
}

async function recheckOpen() {
  const nums = Object.keys(state.open).map(Number);
  await Promise.all(nums.map(async (jobNo) => {
    try {
      const job = await getJob('Order', jobNo);
      if (job) { state.open[jobNo] = { ...job, seenAt: new Date().toISOString() }; return; }
      // No longer open. Look it up in History *before* removing it, so a failed lookup
      // never makes a job vanish from both lists.
      const hist = await getJob('History', jobNo);
      if (hist) { recordInvoiced(hist); delete state.open[jobNo]; return; }
      // In neither list (deleted, converted, or mid-invoice in Printer's Plan). Only drop it
      // after it's been missing for 3 checks in a row, in case it reappears.
      const prev = state.open[jobNo];
      prev.missing = (prev.missing || 0) + 1;
      if (prev.missing >= 3) delete state.open[jobNo];
    } catch {
      /* network problem: keep the job as-is and try again next cycle */
    }
  }));
}

// Shipped jobs saved before the dashboard tracked full totals: re-fetch a batch each cycle.
async function upgradeInvoiced() {
  const stale = Object.values(state.invoiced).filter((v) => v.total === undefined).slice(0, 60);
  await Promise.all(stale.map(async (v) => {
    try {
      const hist = await getJob('History', v.jobNo);
      if (hist) state.invoiced[v.jobNo] = slimInvoiced(hist);
      else state.invoiced[v.jobNo] = { ...v, total: v.subtotal };
    } catch { /* try again next cycle */ }
  }));
}

function pruneInvoiced() {
  for (const [k, v] of Object.entries(state.invoiced)) {
    if (daysAgo(v.dateShipped || v.dateIn) > cfg.invoicedKeepDays) delete state.invoiced[k];
  }
}

let backfillRunning = false;
async function runBackfill() {
  if (backfillRunning || !state.backfill || state.backfill.done) return;
  backfillRunning = true;
  const bf = state.backfill;
  console.log(`[scan] backfill ${bf.next} → ${bf.to}`);
  try {
    while (bf.next <= bf.to) {
      const chunk = [];
      for (let i = 0; i < cfg.maxConcurrency * 4 && bf.next <= bf.to; i++) chunk.push(bf.next++);
      await Promise.all(chunk.map(async (jobNo) => {
        try {
          const job = await getJob('Order', jobNo);
          if (job) { state.open[jobNo] = { ...job, seenAt: new Date().toISOString() }; return; }
          if (jobNo > bf.to - cfg.historySeedCount) {
            const hist = await getJob('History', jobNo);
            if (hist) recordInvoiced(hist);
          }
        } catch { /* skip this number on error */ }
      }));
      save();
    }
    bf.done = true;
    bf.finishedAt = new Date().toISOString();
    console.log(`[scan] backfill finished: ${Object.keys(state.open).length} open jobs`);
  } finally {
    backfillRunning = false;
    save();
  }
}

let cycleRunning = false;
async function cycle() {
  if (cycleRunning) return;
  cycleRunning = true;
  const t0 = Date.now();
  try {
    if (!state.maxJobNo) {
      state.phase = 'finding newest job number';
      state.maxJobNo = cfg.startJobNo || (await discoverNewest());
      console.log(`[scan] newest job number ≈ #${state.maxJobNo}`);
    }
    if (!state.backfill) {
      state.backfill = { from: Math.max(1, state.maxJobNo - cfg.backfillCount), to: state.maxJobNo, done: false };
      state.backfill.next = state.backfill.from;
    }
    runBackfill(); // runs alongside cycles; shares the request limiter
    state.phase = 'checking for new jobs';
    await findNewJobs();
    state.phase = 'refreshing open jobs';
    await recheckOpen();
    await upgradeInvoiced();
    pruneInvoiced();
    state.cycles++;
    state.lastCycleAt = new Date().toISOString();
    state.lastCycleMs = Date.now() - t0;
    state.phase = 'idle';
    save();
  } catch (err) {
    state.phase = 'error: ' + err.message;
    console.error('[scan] cycle failed:', err.message);
  } finally {
    cycleRunning = false;
  }
}

function start() {
  load();
  cycle();
  setInterval(cycle, cfg.refreshSeconds * 1000);
}

function snapshot() {
  const bf = state.backfill;
  // A job drops off the open list as soon as a ship date is entered in Printer's Plan,
  // even before it's invoiced. Those jobs count toward the "shipped" totals instead.
  const all = Object.values(state.open);
  const shipped = { ...state.invoiced };
  for (const j of all) if (j.dateShipped) shipped[j.jobNo] = slimInvoiced(j);
  return {
    open: all.filter((j) => !j.dateShipped),
    invoiced: Object.values(shipped),
    scan: {
      phase: state.phase,
      newestJobNo: state.maxJobNo,
      lastCycleAt: state.lastCycleAt,
      lastCycleMs: state.lastCycleMs,
      backfill: bf ? { done: !!bf.done, progress: bf.done ? 1 : (bf.next - bf.from) / Math.max(1, bf.to - bf.from), from: bf.from, to: bf.to } : null,
      requests: stats.requests,
      errors: stats.errors,
      lastError: stats.lastError,
      lastErrorAt: stats.lastErrorAt,
      lastOkAt: stats.lastOkAt,
    },
  };
}

module.exports = { start, snapshot, todayLocal };
