// Talks to the Printer's Plan Web2Plan listener and turns its XML into plain objects.
// Only ever issues GET requests to Listener.aspx (never XmlListener.aspx, which creates orders).
const cfg = require('./config');

// ---------- simple concurrency limiter shared by every request ----------
let active = 0;
const waiting = [];
function acquire() {
  if (active < cfg.maxConcurrency) { active++; return Promise.resolve(); }
  return new Promise((resolve) => waiting.push(resolve));
}
function release() {
  const next = waiting.shift();
  if (next) next(); else active--;
}

const stats = { requests: 0, errors: 0, lastError: null, lastErrorAt: null, lastOkAt: null };

async function rawGet(params) {
  const url = cfg.listenerUrl + '?' + new URLSearchParams(params).toString();
  await acquire();
  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), cfg.requestTimeoutMs);
      try {
        stats.requests++;
        const res = await fetch(url, { headers: { Referer: cfg.referer, 'User-Agent': 'marathon-shop-dashboard' }, signal: ctrl.signal });
        const text = await res.text();
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (/^PW_[A-Z_]+$/.test(text.trim())) throw new Error(`Listener error ${text.trim()}`);
        stats.lastOkAt = new Date().toISOString();
        return text;
      } catch (err) {
        if (attempt === 2) {
          stats.errors++;
          stats.lastError = String(err.message || err);
          stats.lastErrorAt = new Date().toISOString();
          throw err;
        }
        await new Promise((r) => setTimeout(r, 1500));
      } finally {
        clearTimeout(timer);
      }
    }
  } finally {
    release();
  }
}

// ---------- tiny XML helpers (the listener's XML is flat and predictable) ----------
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decode(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => ENT[e]);
}
function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1]).trim() : '';
}
function block(xml, name) {
  // Sections are nested twice: <BILLTO_ADDRESS><BILLTO_ADDRESS>…</BILLTO_ADDRESS></BILLTO_ADDRESS>
  const m = xml.match(new RegExp(`<${name}>\\s*<${name}>([\\s\\S]*?)</${name}>\\s*</${name}>`));
  return m ? m[1] : '';
}
const n = (v) => (v === '' || v == null || isNaN(Number(v)) ? 0 : Number(v));
const day = (v) => (v ? v.slice(0, 10) : null); // dates arrive as local time with offset, e.g. 2026-10-14T00:00:00-07:00

function parseJob(xml) {
  const j = block(xml, 'JOB_1');
  if (!j) return null;
  const bill = block(xml, 'BILLTO_ADDRESS');
  const ship = block(xml, 'SHIPTO_ADDRESS');
  const buyer = block(xml, 'BUYER_INFO');
  const itemsXml = (xml.match(/<ITEMS_TBL>\s*([\s\S]*)<\/ITEMS_TBL>\s*<\/ITEMS_TBL>/) || [, ''])[1];
  const items = itemsXml
    .split(/<ITEMS_TBL>/)
    .map((s) => s.replace(/<\/ITEMS_TBL>/g, ''))
    .filter((s) => /<ItemID>/.test(s))
    .map((s) => ({
      itemNo: n(tag(s, 'ItemNo')),
      subNo: n(tag(s, 'SubNo')),
      serNo: n(tag(s, 'SerNo')), // 0 = a product line; >0 = a service/operation on that line
      status: n(tag(s, 'Status')),
      empNo: n(tag(s, 'EmpNo')),
      qty: n(tag(s, 'ChargeQty')),
      price: n(tag(s, 'Price')),
      description: tag(s, 'Description'),
      note: tag(s, 'Note').slice(0, 200),
    }));
  const money = (v) => { const x = n(v); return x < 0.01 && x > -0.01 ? 0 : x; }; // 0.0001 is a placeholder price
  return {
    jobId: n(tag(j, 'JobID')),
    jobNo: n(tag(j, 'JobNo')),
    jobType: n(tag(j, 'JobType')), // 0 open order, 1 estimate, 2 template, 3 history/invoiced, 4 web order
    title: tag(j, 'Title'),
    status: n(tag(j, 'Status')),
    csrNo: n(tag(j, 'CSRNo')),
    repNo: n(tag(j, 'SRepNo')),
    cusNo: n(tag(j, 'CusNo')),
    customer: tag(bill, 'Name'),
    shipTo: tag(ship, 'Company') || tag(ship, 'Name'),
    shipAttention: tag(ship, 'Attention'),
    buyer: tag(buyer, 'Name'),
    po: tag(j, 'PO'),
    dateIn: day(tag(j, 'DateIn')),
    dateDue: day(tag(j, 'DateDue')),
    timeDue: tag(j, 'TimeDue'),
    proofTime: tag(j, 'ProofTime'),
    dateShipped: day(tag(j, 'DateShipped')),
    subtotal: money(tag(j, 'Subtotal')),
    // Job total as Printer's Plan figures it: subtotal + discount (stored negative) + shipping
    // + postage + tax + late fee. Matches Balance - Paid - Writeoff on every job checked.
    total: money(['Subtotal', 'Discount', 'Shipping', 'Postage', 'Tax', 'Tax2', 'Latefee'].reduce((t, k) => t + n(tag(j, k)), 0).toFixed(2)),
    discount: n(tag(j, 'Discount')),
    shipping: n(tag(j, 'Shipping')) + n(tag(j, 'Postage')),
    cost: money(tag(j, 'Cost')),
    balance: money(tag(j, 'Balance')),
    workOrderPrinted: tag(j, 'WOrderPrinted') === '1',
    fromJobType: n(tag(j, 'FromJobType')),
    fromJobNo: n(tag(j, 'FromJobNo')),
    workOrderNote: tag(j, 'WOrderNote').slice(0, 600),
    items,
  };
}

/**
 * Look up one job. Returns the parsed job, or null if that number doesn't exist for that type.
 * Throws on network/server errors so callers never mistake an outage for "job closed".
 * type: 'Order' (open jobs) | 'History' (invoiced) | 'Quote' | 'WebOrder' | 'Template'
 */
async function getJob(type, jobNo) {
  const xml = await rawGet({ todo: 'GetJob', type, jobno: String(jobNo) });
  if (!xml || !xml.trim()) return null;
  return parseJob(xml);
}

module.exports = { getJob, parseJob, stats };
