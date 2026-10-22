// Stage history: Printer's Plan only stores each item's *current* status, so the dashboard
// records the moment it sees a status change while re-checking open jobs (about once a minute).
//
// Every change is appended to DATA_DIR/stage-log.jsonl (one JSON event per line) and is kept
// for good. Each event carries `at` (when the dashboard saw the new status) and `prevSeenAt`
// (the last time it saw the old status), so the real change happened somewhere in between —
// normally a window of about a minute, longer if the dashboard was down.
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

const LOG_FILE = path.join(cfg.dataDir, 'stage-log.jsonl');
const STATE_FILE = path.join(cfg.dataDir, 'stage-log-state.json');

let labels = {};
let events = []; // all events, oldest first
// jobNo -> { seenAt, shipped, items: { itemNo: { status, description } }, title, customer, csrNo }
let last = {};

function init(lbls) {
  labels = lbls || {};
  try {
    events = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { events = []; }
  try { last = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { last = {}; }
  console.log(`[stages] ${events.length} stage events on file, tracking ${Object.keys(last).length} jobs`);
}

const statusName = (code) => (code == null ? '' : (labels.itemStatus || {})[String(code)] || `Status ${code}`);
function pressesFor(job, itemNo) {
  const list = labels.presses || [];
  return list.filter((p) => (job.items || []).some((s) => s.itemNo === itemNo && s.serNo > 0 && p.services.map(Number).includes(s.serNo))).map((p) => p.name).join(' + ');
}

let pending = [];
let saveTimer = null;
function flush() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(cfg.dataDir, { recursive: true });
      if (pending.length) { fs.appendFileSync(LOG_FILE, pending.map((e) => JSON.stringify(e)).join('\n') + '\n'); pending = []; }
      const tmp = STATE_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(last));
      fs.renameSync(tmp, STATE_FILE);
    } catch (err) {
      console.error('[stages] could not save stage log:', err.message);
    }
  }, 500);
}
function add(e) { events.push(e); pending.push(e); }

// Called every time the scanner reads an open job. `isNew` = a newly created job number
// (found while probing past the newest job), so its first-seen time is close to when it was entered.
function observe(job, { isNew = false } = {}) {
  if (!job || !job.jobNo) return;
  const now = new Date().toISOString();
  const prev = last[job.jobNo];
  const base = { job: job.jobNo, title: job.title, customer: job.customer, csrNo: job.csrNo };
  const items = {};
  for (const i of job.items || []) {
    if (i.serNo !== 0) continue;
    items[i.itemNo] = { status: i.status, description: i.description };
    const before = prev && prev.items[i.itemNo];
    if (!before) {
      add({ ...base, at: now, prevSeenAt: null, kind: prev ? 'item-added' : isNew ? 'new' : 'first-seen', item: i.itemNo, description: i.description, from: null, fromName: '', to: i.status, toName: statusName(i.status), press: pressesFor(job, i.itemNo) });
    } else if (before.status !== i.status) {
      add({ ...base, at: now, prevSeenAt: prev.seenAt, kind: 'change', item: i.itemNo, description: i.description, from: before.status, fromName: statusName(before.status), to: i.status, toName: statusName(i.status), press: pressesFor(job, i.itemNo) });
    }
  }
  const shipped = !!job.dateShipped;
  if (prev && shipped && !prev.shipped) add({ ...base, at: now, prevSeenAt: prev.seenAt, kind: 'shipped', item: null, description: '', from: null, fromName: '', to: null, toName: 'Ship date entered', press: '' });
  last[job.jobNo] = { seenAt: now, shipped, items, title: job.title, customer: job.customer, csrNo: job.csrNo };
  flush();
}

// The job left the open list (found in History = invoiced).
function closed(jobNo, why) {
  const prev = last[jobNo];
  if (!prev) return;
  add({ job: Number(jobNo), title: prev.title, customer: prev.customer, csrNo: prev.csrNo, at: new Date().toISOString(), prevSeenAt: prev.seenAt, kind: 'closed', item: null, description: '', from: null, fromName: '', to: null, toName: why, press: '' });
  delete last[jobNo];
  flush();
}

// ---------- reporting ----------
// Local time for spreadsheets: "2026-10-22 09:14"
function local(iso) {
  if (!iso) return '';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: cfg.timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
// Midnight at the start of a local date ("2026-10-22", plus `addDays`), as a UTC ISO string.
function localMidnightIso(date, addDays = 0) {
  const d = new Date(date + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + addDays);
  const ymd = d.toISOString().slice(0, 10);
  // offset of the time zone on that day (handles daylight saving)
  const asLocal = new Date(new Date(ymd + 'T12:00:00Z').toLocaleString('en-US', { timeZone: cfg.timeZone }) + ' UTC');
  const offsetMs = asLocal - new Date(ymd + 'T12:00:00Z');
  return new Date(new Date(ymd + 'T00:00:00Z').getTime() - offsetMs).toISOString();
}
const hours = (a, b) => (a && b ? Math.round(((new Date(b) - new Date(a)) / 3600000) * 100) / 100 : '');
const csrName = (n) => (labels.csr || {})[String(n)] || (n ? `#${n}` : '');
const inRange = (e, from, to) => (!from || e.at >= from) && (!to || e.at < to);

function list({ from, to } = {}) {
  return events.filter((e) => inRange(e, from, to));
}

// One row per job item, with when it was first seen and when it entered each stage.
function summary({ from, to } = {}) {
  const codeOf = (name) => Object.entries(labels.itemStatus || {}).filter(([, v]) => v === name).map(([k]) => Number(k));
  const NA = codeOf('Not Approved'), PP = codeOf('Pre Press'), PR = codeOf('Press');
  const rows = new Map();
  for (const e of events) {
    if (e.item == null) {
      for (const r of rows.values()) if (r.job === e.job) { if (e.kind === 'shipped' && !r.shippedAt) r.shippedAt = e.at; if (e.kind === 'closed' && !r.closedAt) r.closedAt = e.at; }
      continue;
    }
    const k = e.job + '/' + e.item;
    let r = rows.get(k);
    if (!r) { r = { job: e.job, item: e.item, description: e.description, title: e.title, customer: e.customer, csrNo: e.csrNo, firstSeenAt: e.at, firstSeenKind: e.kind, firstStage: e.toName }; rows.set(k, r); }
    r.stage = e.toName; r.press = e.press || r.press; r.description = e.description || r.description; r.lastChangeAt = e.at;
    // A brand-new job seen within a minute of being entered counts as entering its first stage then.
    // Items can go backwards (e.g. sent back to Not Approved for a new proof), so the summary keeps
    // the LATEST pass through each stage; a move back clears the later milestones.
    const entered = e.kind === 'change' || e.kind === 'new';
    if (e.kind === 'change' && NA.includes(e.to) && !NA.includes(e.from)) { r.sentBack = (r.sentBack || 0) + 1; r.approvedAt = r.prePressAt = r.pressAt = r.leftPressAt = r.leftPressTo = null; }
    if (e.kind === 'change' && NA.includes(e.from)) r.approvedAt = e.at;
    if (entered && PP.includes(e.to)) { r.prePressAt = e.at; r.pressAt = r.leftPressAt = r.leftPressTo = null; }
    if (entered && PR.includes(e.to)) { r.pressAt = e.at; r.leftPressAt = r.leftPressTo = null; }
    if (e.kind === 'change' && PR.includes(e.from) && !PR.includes(e.to)) { r.leftPressAt = e.at; r.leftPressTo = e.toName; }
  }
  let out = [...rows.values()];
  if (from || to) out = out.filter((r) => [r.firstSeenAt, r.lastChangeAt].some((t) => t && (!from || t >= from) && (!to || t < to)));
  return out.sort((a, b) => a.job - b.job || a.item - b.item);
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const toCsv = (head, rows) => '﻿' + [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'; // BOM so Excel reads UTF-8

function eventsCsv(opts) {
  const KIND = { change: 'Stage change', new: 'New job', 'first-seen': 'First seen (already open when tracking started)', 'item-added': 'Item added', shipped: 'Ship date entered', closed: 'Left open list' };
  return toCsv(
    ['Seen at', 'Changed after', 'Job', 'Item', 'Description', 'From stage', 'To stage', 'Press', 'Event', 'Customer', 'Title', 'CSR'],
    list(opts).map((e) => [local(e.at), local(e.prevSeenAt), e.job, e.item ?? '', e.description, e.fromName, e.toName, e.press, KIND[e.kind] || e.kind, e.customer, e.title, csrName(e.csrNo)]),
  );
}

function summaryCsv(opts) {
  return toCsv(
    ['Job', 'Item', 'Description', 'Customer', 'Title', 'CSR', 'Press', 'First seen', 'First seen in stage', 'Approved (left Not Approved)', 'Entered Pre Press', 'Entered Press', 'Left Press', 'Left Press to', 'Ship date entered', 'Hours Pre Press to Press', 'Hours in Press stage', 'Current/last stage', 'Times sent back to Not Approved'],
    summary(opts).map((r) => [r.job, r.item, r.description, r.customer, r.title, csrName(r.csrNo), r.press, local(r.firstSeenAt), r.firstStage, local(r.approvedAt), local(r.prePressAt), local(r.pressAt), local(r.leftPressAt), r.leftPressTo || '', local(r.shippedAt), hours(r.prePressAt, r.pressAt), hours(r.pressAt, r.leftPressAt), r.stage, r.sentBack || 0]),
  );
}

module.exports = { localMidnightIso, init, observe, closed, list, summary, eventsCsv, summaryCsv, local, count: () => events.length, since: () => (events[0] ? events[0].at : null) };
