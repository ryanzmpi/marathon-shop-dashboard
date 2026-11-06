// Jobs entered in the Marathon MIS (ryanzmpi/marathon-mis), read from its read-only dashboard feed
// (GET <MIS_URL>/feed/dashboard with MIS_FEED_KEY). The MIS sends them already in the same shape as a
// Printer's Plan job (items with Printer's Plan status codes and service numbers), so they show in
// every list, chart, gauge and TV. They carry source: 'mis' and key: 'M<job number>'.
//
// Printer's Plan stays the main source: if the MIS can't be reached, its jobs keep showing from the
// last good copy (saved in DATA_DIR/mis-cache.json, so it survives a redeploy) and the dashboard
// otherwise carries on as before. Set MIS_URL=off (or leave it unset) to leave MIS jobs out.
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

const CACHE_FILE = path.join(cfg.dataDir, 'mis-cache.json');
const state = { open: [], shipped: [], lastOkAt: null, lastError: null, lastErrorAt: null, fetching: false, lastTryAt: 0, failures: 0 };
try {
  const saved = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  Object.assign(state, { open: saved.open || [], shipped: saved.shipped || [], lastOkAt: saved.lastOkAt || null });
  console.log(`[mis] loaded last known MIS data from ${state.lastOkAt}: ${state.open.length} open jobs`);
} catch { /* first run */ }
function saveCache() {
  try {
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    fs.writeFileSync(CACHE_FILE + '.tmp', JSON.stringify({ open: state.open, shipped: state.shipped, lastOkAt: state.lastOkAt }));
    fs.renameSync(CACHE_FILE + '.tmp', CACHE_FILE);
  } catch (err) { console.error('[mis] could not save cache:', err.message); }
}

// Only what the dashboard uses, with types it expects (a bad field never breaks a page).
const num = (v) => (isFinite(Number(v)) ? Number(v) : 0);
const str = (v, max = 300) => (v == null ? '' : String(v)).slice(0, max);
const day = (v) => (/^\d{4}-\d{2}-\d{2}/.test(String(v || '')) ? String(v).slice(0, 10) : null);
function clean(j) {
  return {
    source: 'mis', key: 'M' + num(j.jobNo), misId: num(j.misId), jobNo: num(j.jobNo), jobType: 0,
    title: str(j.title), customer: str(j.customer), buyer: str(j.buyer), po: str(j.po, 60),
    shipTo: str(j.shipTo), shipAttention: str(j.shipAttention), shipVia: j.shipVia == null ? null : num(j.shipVia), shipService: str(j.shipService, 80),
    csrNo: num(j.csrNo), csrName: str(j.csrName, 40), status: num(j.status), onHold: !!j.onHold, rush: !!j.rush,
    reprint: !!j.reprint, reprintReason: j.reprintReason ? str(j.reprintReason, 120) : null,
    rescheduled: !!j.rescheduled, movedFrom: day(j.movedFrom), rescheduleReason: j.rescheduleReason ? str(j.rescheduleReason, 120) : null,
    shipUpgradedFrom: j.shipUpgradedFrom ? str(j.shipUpgradedFrom, 80) : null,
    dateIn: day(j.dateIn), dateDue: day(j.dateDue), timeDue: '', dateShipped: day(j.dateShipped),
    subtotal: num(j.subtotal), total: num(j.total), shipping: num(j.shipping), workOrderNote: str(j.workOrderNote, 600), workOrderPrinted: false,
    misStage: str(j.stage, 60),
    items: (Array.isArray(j.items) ? j.items : []).slice(0, 400).map((i) => ({
      itemNo: num(i.itemNo), subNo: num(i.subNo), serNo: num(i.serNo), status: num(i.status), empNo: 0, qty: num(i.qty), minutes: num(i.minutes),
      price: num(i.price), description: str(i.description, 200), note: str(i.note, 200),
    })),
  };
}

async function getFeed() {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), cfg.requestTimeoutMs);
  try {
    const res = await fetch(cfg.misUrl + '/feed/dashboard', { signal: ctl.signal, headers: { Accept: 'application/json', 'X-Feed-Key': cfg.misFeedKey, 'User-Agent': 'marathon-shop-dashboard' } });
    if (!res.ok) throw new Error(`MIS feed → HTTP ${res.status}`);
    const d = await res.json();
    if (!d || !Array.isArray(d.open) || !Array.isArray(d.shipped)) throw new Error('MIS feed: unexpected answer');
    return d;
  } finally {
    clearTimeout(t);
  }
}

// Every MIS_REFRESH_SECONDS (default 60); after a failure, wait longer each time (up to 15 min).
async function refresh() {
  if (!cfg.misUrl || state.fetching) return;
  const wait = state.failures ? Math.min(900, cfg.misRefreshSeconds * 2 ** (state.failures - 1)) : cfg.misRefreshSeconds;
  if (Date.now() - state.lastTryAt < wait * 1000 - 5000) return;
  state.lastTryAt = Date.now();
  state.fetching = true;
  try {
    const d = await getFeed();
    state.open = d.open.map(clean).filter((j) => j.jobNo && !j.dateShipped);
    state.shipped = [...d.shipped, ...d.open.filter((j) => j.dateShipped)].map(clean).filter((j) => j.jobNo && j.dateShipped);
    state.lastOkAt = new Date().toISOString();
    state.failures = 0;
    saveCache();
  } catch (err) {
    state.lastError = err.name === 'AbortError' ? 'MIS feed timed out' : err.message;
    state.lastErrorAt = new Date().toISOString();
    state.failures++;
    console.error('[mis]', state.lastError);
  } finally {
    state.fetching = false;
  }
}

function status() {
  return { enabled: !!cfg.misUrl, stale: !!(state.lastErrorAt && (!state.lastOkAt || state.lastErrorAt > state.lastOkAt)), lastOkAt: state.lastOkAt, lastError: state.lastError, lastErrorAt: state.lastErrorAt, open: state.open.length };
}

module.exports = { refresh, status, openJobs: () => (cfg.misUrl ? state.open : []), shippedJobs: () => (cfg.misUrl ? state.shipped : []), clean };
