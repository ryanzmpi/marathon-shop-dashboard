// Atlas (the GoMake MIS) orders, read from the Atlas Dashboard's own JSON API
// (ryanzmpi/gomake-dashboard), which already logs in to GoMake and caches orders.
// Read-only: only GET /api/orders?page=N and GET /api/orders/{id}/jobs are used.
//
// Each Atlas order is turned into the same shape as a Printer's Plan job, so it shows up in
// every list, chart, gauge and TV. Atlas orders carry source: 'atlas' and key: 'A<number>'
// (order numbers can repeat between the two systems, so the key keeps them apart).
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

// The last good copy of Atlas orders is saved here, so the dashboard keeps showing it while the
// Atlas Dashboard (or GoMake behind it) is unreachable — including right after a redeploy.
const CACHE_FILE = path.join(cfg.dataDir, 'atlas-cache.json');

const state = { orders: [], open: [], shipped: [], lastOkAt: null, lastError: null, lastErrorAt: null, fetching: false, lastTryAt: 0, failures: 0 };
try {
  const saved = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  Object.assign(state, { open: saved.open || [], shipped: saved.shipped || [], orders: saved.orders || 0, lastOkAt: saved.lastOkAt || null });
  console.log(`[atlas] loaded last known Atlas data from ${state.lastOkAt}: ${state.open.length} open orders`);
} catch { /* first run */ }
function saveCache() {
  try {
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    fs.writeFileSync(CACHE_FILE + '.tmp', JSON.stringify({ open: state.open, shipped: state.shipped, orders: state.orders, lastOkAt: state.lastOkAt }));
    fs.renameSync(CACHE_FILE + '.tmp', CACHE_FILE);
  } catch (err) { console.error('[atlas] could not save cache:', err.message); }
}

// Atlas job statuses → dashboard stage codes. These codes have names in labels.itemStatus
// (105 "Not Approved", 106 "Pre Press", …) so they sort and colour like Printer's Plan stages.
const CODE = { notApproved: 105, prePress: 106, press: 108, screen: 110, misc: 113, wide: 114, finishing: 116, packing: 118 };
const has = (s, ...words) => words.some((w) => s.includes(w));
function stageOf(st) {
  const status = (st.status || '').toLowerCase(), station = (st.currentStation || '').toLowerCase(), machine = (st.machineName || '').toLowerCase();
  const either = status + ' | ' + station;
  // Same rules as the Atlas Dashboard tabs (server.py), checked most-specific first.
  if (has(either, 'exposure', 'stencil', 'mesh preparing', 'film printing') || (machine.includes('screen printing') && either.includes('printing'))) return CODE.screen;
  if (has(machine, 'hp latex', 'mimaki') || has(station, 'roll sheeter', 'fabric folding', 'rings') || machine.includes('hand cutting') || (station.includes('cutting') && machine.includes('cnc'))) return CODE.wide;
  if (has(either, 'prepress', 'graphics')) return CODE.prePress;
  if (either.includes('printing')) return CODE.press;
  if (has(either, 'cutting', 'folding', 'lamination', 'scoring', 'gathering', 'saddle')) return CODE.finishing;
  if (either.includes('packing')) return CODE.packing;
  return CODE.misc;
}
// "Indigo 7900" → "Indigo" (matches the press names used for Printer's Plan)
function pressName(machine) {
  const m = (machine || '').toLowerCase();
  for (const p of ['Indigo', 'Ricoh', 'Konica']) if (m.includes(p.toLowerCase())) return p;
  return machine || '';
}
const DONE = /done|complet|finish/i;

// Atlas sends UTC times without a zone ("2026-10-23T17:46:03" or "23-10-2026 17:46").
function utcToLocalDate(s) {
  if (!s) return null;
  let iso = s;
  const m = /^(\d{2})-(\d{2})-(\d{4})[ T](\d{2}):(\d{2})/.exec(s);
  if (m) iso = `${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:00`;
  const d = new Date(iso.replace(/Z?$/, 'Z'));
  if (isNaN(d)) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: cfg.timeZone }).format(d);
}
const num = (v) => (isFinite(Number(v)) ? Number(v) : 0);
const firstName = (s) => (s ? String(s).trim().split(/\s+/)[0] : '');

function isOpenOrder(o) { return !/closed/i.test(o.statusTitleText || '') && o.deliveryStatus !== 3; }

function normalize(o, jobs) {
  const items = [];
  (jobs || []).forEach((jb, k) => {
    const sts = jb.jobStatuses || [];
    const live = sts.filter((s) => !DONE.test(s.status || ''));
    const codes = live.map(stageOf);
    const printing = live.filter((s) => stageOf(s) === CODE.press && s.machineName);
    items.push({
      itemNo: k + 1, subNo: 0, serNo: 0, empNo: 0, price: 0, note: '',
      status: o.isInProofingProcess ? CODE.notApproved : codes.length ? Math.min(...codes) : null,
      qty: num(jb.quantity),
      description: jb.productName || '',
      press: [...new Set(printing.map((s) => pressName(s.machineName)))].join(' + '),
      steps: sts.map((s) => [s.productType, s.currentStation, s.status, s.machineName].filter(Boolean).join(' · ')),
    });
  });
    // An order marked Ready in GoMake is finished, even if its steps still say "Waiting"
  // (same rule as the Atlas Dashboard).
  const ready = o.readyDate ? utcToLocalDate(o.readyDate) : null;
  const total = num(o.totalPrice || o.totalPayment);
  return {
    source: 'atlas',
    key: 'A' + (o.number || o.id),
    atlasId: o.id,
    jobNo: Number(o.number) || 0,
    title: String(o.worksNames || o.title || '').replace(/^[,\s]+|[,\s]+$/g, ''),
    customer: o.customerName || o.contactName || '',
    buyer: o.contactName || '',
    po: o.purchaseOrderNumber || '',
    csrNo: 0,
    // CSR = Atlas's Sales Rep. The Atlas Dashboard adds it as `csr` (first name); GoMake's own
    // order list carries the same person as agentName ("Ryan Zirk"), used when csr is blank.
    csrName: firstName(o.csr) || firstName(o.customerSupportRepresentativeName) || firstName(o.agentName),
    repName: o.agentName || o.csr || '',
    dateIn: utcToLocalDate(o.createdDate),
    dateDue: o.dueDate ? String(o.dueDate).slice(0, 10) : null,
    dateShipped: ready,
    workOrderNote: [o.notes, o.internalNotes].filter(Boolean).join('\n').slice(0, 600),
    subtotal: total,
    total,
    items: items.filter((i) => i.status != null || !jobs),
  };
}

async function getJson(path) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), cfg.requestTimeoutMs);
  try {
    const res = await fetch(cfg.atlasUrl + path, { signal: ctl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Atlas ${path} → HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// Pull every order page, then the job steps for each open order. Called once per scan cycle.
// How often to ask the Atlas Dashboard (ATLAS_REFRESH_SECONDS, default 150 s — it only refreshes
// from GoMake every 150 s anyway, and answers us from its cache, so we add no GoMake calls). After a failure, wait longer each time (up to 15 min).
async function refresh() {
  if (!cfg.atlasUrl || state.fetching) return;
  const wait = state.failures ? Math.min(900, cfg.atlasRefreshSeconds * 2 ** (state.failures - 1)) : cfg.atlasRefreshSeconds;
  if (Date.now() - state.lastTryAt < wait * 1000 - 5000) return;
  state.lastTryAt = Date.now();
  state.fetching = true;
  try {
    let all = [];
    for (let page = 0; page < 200; page++) {
      const d = await getJson(`/api/orders?page=${page}`);
      const arr = (d && d.data && d.data.data) || (d && d.data) || (d && d.orders) || (Array.isArray(d) ? d : []);
      if (!Array.isArray(arr)) break;
      all = all.concat(arr);
      if (arr.length < 100) break;
    }
    const open = all.filter(isOpenOrder);
    const jobsById = {};
    let k = 0;
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (k < open.length) {
        const o = open[k++];
        try { jobsById[o.id] = await getJson(`/api/orders/${o.id}/jobs`); } catch { jobsById[o.id] = null; }
      }
    }));
    const jobs = [];
    for (const o of open) {
      const prev = state.open.find((j) => j.atlasId === o.id);
      if (jobsById[o.id] === null && prev) { jobs.push(prev); continue; } // couldn't read steps this time: keep the last version
      jobs.push(normalize(o, jobsById[o.id] || []));
    }
    state.open = jobs.filter((j) => !j.dateShipped);
    // Finished orders (ready, or closed with a ready date) count toward shipped totals.
    state.shipped = [
      ...jobs.filter((j) => j.dateShipped),
      ...all.filter((o) => !isOpenOrder(o) && o.readyDate).map((o) => normalize(o, null)),
    ];
    state.orders = all.length;
    state.lastOkAt = new Date().toISOString();
    state.failures = 0;
    saveCache();
  } catch (err) {
    // Keep showing the last good data; just note the error and back off.
    state.lastError = err.message;
    state.lastErrorAt = new Date().toISOString();
    state.failures++;
    console.error('[atlas]', err.message);
  } finally {
    state.fetching = false;
  }
}

function status() {
  return { enabled: !!cfg.atlasUrl, stale: !!(state.lastErrorAt && (!state.lastOkAt || state.lastErrorAt > state.lastOkAt)), lastOkAt: state.lastOkAt, lastError: state.lastError, lastErrorAt: state.lastErrorAt, open: state.open.length, orders: state.orders };
}

module.exports = { refresh, status, openJobs: () => state.open, shippedJobs: () => state.shipped, normalize, stageOf, CODE };
