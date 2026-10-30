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
// Dates typed in from Printer's Plan for changes the dashboard didn't see (date only, no time).
const MANUAL_FILE = path.join(cfg.dataDir, 'stage-manual.json');
const MILESTONES = { approved: 'Approved', prePress: 'Pre Press', press: 'Press', leftPress: 'Left Press' };
let manual = {}; // "job/item/milestone" -> { job, item (null = whole job), milestone, date: 'YYYY-MM-DD', addedAt }
let jobInfo = () => null; // jobNo -> { title, customer, csrNo } from the scanner, for jobs with no events

let labels = {};
let events = []; // all events, oldest first
// jobNo -> { seenAt, shipped, items: { itemNo: { status, description } }, title, customer, csrNo }
let last = {};

function init(lbls, info) {
  labels = lbls || {};
  if (info) jobInfo = info;
  try { manual = JSON.parse(fs.readFileSync(MANUAL_FILE, 'utf8')); } catch { manual = {}; }
  try {
    events = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { events = []; }
  try { last = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { last = {}; }
  console.log(`[stages] ${events.length} stage events on file, tracking ${Object.keys(last).length} jobs`);
}

const statusName = (code) => (code == null ? '' : (labels.itemStatus || {})[String(code)] || `Status ${code}`);
function pressesFor(job, itemNo) {
  const main = (job.items || []).find((i) => i.itemNo === itemNo && i.serNo === 0);
  if (main && main.press) return main.press; // Atlas items name their press directly
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
  if (!job || !(job.key || job.jobNo)) return;
  const id = job.key || job.jobNo; // Atlas orders use "A268506" so they never mix with Printer's Plan numbers
  const now = new Date().toISOString();
  const prev = last[id];
  const base = { job: id, title: job.title, customer: job.customer, csrNo: job.csrNo, csrName: job.csrName, dateDue: job.dateDue || null };
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
  last[id] = { seenAt: now, shipped, items, title: job.title, customer: job.customer, csrNo: job.csrNo, csrName: job.csrName, dateDue: job.dateDue || null };
  flush();
}

// The job left the open list (found in History = invoiced).
function closed(jobNo, why) {
  const prev = last[jobNo];
  if (!prev) return;
  add({ job: /^\d+$/.test(String(jobNo)) ? Number(jobNo) : String(jobNo), title: prev.title, customer: prev.customer, csrNo: prev.csrNo, csrName: prev.csrName, at: new Date().toISOString(), prevSeenAt: prev.seenAt, kind: 'closed', item: null, description: '', from: null, fromName: '', to: null, toName: why, press: '' });
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
// Hours between two times counting only shop hours (cfg.workDays, cfg.workStartHour–workEndHour,
// Pacific). A job that waits from Friday 3pm to Monday 9am counts as 2 work hours, not 66.
const dow = (ymd) => new Date(ymd + 'T12:00:00Z').getUTCDay();
const nextDay = (ymd) => { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };
function workHours(a, b) {
  if (!a || !b) return '';
  const A = new Date(a).getTime(), B = new Date(b).getTime();
  if (!(B > A)) return 0;
  let ms = 0;
  for (let d = local(a).slice(0, 10), end = local(b).slice(0, 10); d <= end; d = nextDay(d)) {
    if (!cfg.workDays.includes(dow(d))) continue;
    const mid = new Date(localMidnightIso(d)).getTime();
    const open = mid + cfg.workStartHour * 3600000, close = mid + cfg.workEndHour * 3600000;
    ms += Math.max(0, Math.min(B, close) - Math.max(A, open));
  }
  return Math.round((ms / 3600000) * 100) / 100;
}
// Working days between two dates (for hand-entered dates that have no time): Mon 10/26 → Wed 10/28 = 2.
function workDays(x, y) {
  if (!x || !y) return '';
  if (y < x) return -workDays(y, x);
  let n = 0;
  for (let d = x; d < y; d = nextDay(d)) if (cfg.workDays.includes(dow(nextDay(d)))) n++;
  return n;
}
const hours = (a, b) => (a && b ? Math.round(((new Date(b) - new Date(a)) / 3600000) * 100) / 100 : '');
const csrName = (n) => (labels.csr || {})[String(n)] || (n ? `#${n}` : '');
const inRange = (e, from, to) => (!from || e.at >= from) && (!to || e.at < to);

// Due date: the job's current due date when the dashboard still knows the job, otherwise the one
// recorded with the event (events from before this was added have none).
function dueDate(job, fallback) {
  const info = jobInfo(job);
  return (info && info.dateDue) || fallback || '';
}
function list({ from, to } = {}) {
  return events.filter((e) => inRange(e, from, to)).map((e) => ({ ...e, dateDue: dueDate(e.job, e.dateDue) }));
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
    if (!r) { r = { job: e.job, item: e.item, description: e.description, title: e.title, customer: e.customer, csrNo: e.csrNo, csrName: e.csrName, dateDue: e.dateDue, firstSeenAt: e.at, firstSeenKind: e.kind, firstStage: e.toName }; rows.set(k, r); }
    if (e.dateDue) r.dateDue = e.dateDue;
    r.stage = e.toName; r.press = e.press || r.press; r.description = e.description || r.description; r.lastChangeAt = e.at;
    // A brand-new job seen within a minute of being entered counts as entering its first stage then.
    // Items can go backwards (e.g. sent back to Not Approved for a new proof), so the summary keeps
    // the LATEST pass through each stage; a move back clears the later milestones.
    const entered = e.kind === 'change' || e.kind === 'new';
    if (e.kind === 'change' && NA.includes(e.to) && !NA.includes(e.from)) { r.sentBack = (r.sentBack || 0) + 1; r.sentBackAt = e.at; r.approvedAt = r.prePressAt = r.pressAt = r.leftPressAt = r.leftPressTo = null; }
    if (e.kind === 'change' && NA.includes(e.from)) r.approvedAt = e.at;
    if (entered && PP.includes(e.to)) { r.prePressAt = e.at; r.pressAt = r.leftPressAt = r.leftPressTo = null; }
    if (entered && PR.includes(e.to)) { r.pressAt = e.at; r.leftPressAt = r.leftPressTo = null; }
    if (e.kind === 'change' && PR.includes(e.from) && !PR.includes(e.to)) { r.leftPressAt = e.at; r.leftPressTo = e.toName; }
  }
  // Hand-entered dates fill in milestones the dashboard has no recorded time for.
  for (const m of Object.values(manual)) {
    let targets = [...rows.values()].filter((r) => r.job === m.job && (m.item == null || r.item === m.item));
    if (!targets.length) {
      const info = jobInfo(m.job) || {};
      const r = { job: m.job, item: m.item ?? '', description: '', title: info.title || '', customer: info.customer || '', csrNo: info.csrNo, dateDue: info.dateDue, stage: '', manualOnly: true };
      rows.set(m.job + '/' + (m.item ?? '*'), r);
      targets = [r];
    }
    const ORDER = Object.keys(MILESTONES);
    for (const r of targets) {
      if (r[m.milestone + 'At']) continue; // a recorded time wins
      // Skip a typed date that contradicts what was recorded: earlier than a recorded earlier
      // milestone, or from before the item was sent back to Not Approved (that pass was undone).
      const day = (iso) => local(iso).slice(0, 10);
      if (r.sentBackAt && m.date < day(r.sentBackAt)) continue;
      if (ORDER.slice(0, ORDER.indexOf(m.milestone)).some((k) => r[k + 'At'] && day(r[k + 'At']) > m.date)) continue;
      if (ORDER.slice(ORDER.indexOf(m.milestone) + 1).some((k) => r[k + 'At'] && day(r[k + 'At']) < m.date)) continue;
      r[m.milestone + 'Date'] = m.date;
      r.manualDates = [...new Set([...(r.manualDates || []), MILESTONES[m.milestone]])];
    }
  }
  let out = [...rows.values()];
  if (from || to) {
    const fromD = from && local(from).slice(0, 10), toD = to && local(new Date(new Date(to) - 1).toISOString()).slice(0, 10);
    out = out.filter((r) => [r.firstSeenAt, r.lastChangeAt].some((t) => t && (!from || t >= from) && (!to || t < to))
      || Object.keys(MILESTONES).some((k) => r[k + 'Date'] && (!fromD || r[k + 'Date'] >= fromD) && (!toD || r[k + 'Date'] <= toD)));
  }
  for (const r of out) {
    r.dateDue = dueDate(r.job, r.dateDue);
    r.workPrePressToPress = workHours(r.prePressAt, r.pressAt);
    r.workInPress = workHours(r.pressAt, r.leftPressAt);
    r.workDaysPrePressToPress = days(r, 'prePress', 'press');
    r.workDaysInPress = days(r, 'press', 'leftPress');
  }
  return out.sort((a, b) => String(a.job).localeCompare(String(b.job), undefined, { numeric: true }) || String(a.item).localeCompare(String(b.item), undefined, { numeric: true }));
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const toCsv = (head, rows) => '﻿' + [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'; // BOM so Excel reads UTF-8

function eventsCsv(opts) {
  const KIND = { change: 'Stage change', new: 'New job', 'first-seen': 'First seen (already open when tracking started)', 'item-added': 'Item added', shipped: 'Ship date entered', closed: 'Left open list' };
  return toCsv(
    ['Seen at', 'Changed after', 'Job', 'Item', 'Description', 'Due date', 'From stage', 'To stage', 'Press', 'Event', 'Customer', 'Title', 'CSR'],
    list(opts).map((e) => [local(e.at), local(e.prevSeenAt), e.job, e.item ?? '', e.description, e.dateDue || '', e.fromName, e.toName, e.press, KIND[e.kind] || e.kind, e.customer, e.title, e.csrName || csrName(e.csrNo)]),
  );
}

// A milestone as text: recorded time ("2026-10-22 09:14") or a hand-entered date ("2026-10-14").
const when = (r, k) => (r[k + 'At'] ? local(r[k + 'At']) : r[k + 'Date'] || '');
// Calendar days between two milestones (works for hand-entered dates too).
function days(r, a, b) {
  const x = when(r, a).slice(0, 10), y = when(r, b).slice(0, 10);
  return x && y ? workDays(x, y) : '';
}
function summaryCsv(opts) {
  return toCsv(
    ['Job', 'Item', 'Description', 'Due date', 'Customer', 'Title', 'CSR', 'Press', 'First seen', 'First seen in stage', 'Approved (left Not Approved)', 'Entered Pre Press', 'Entered Press', 'Left Press', 'Left Press to', 'Ship date entered', 'Work hours Pre Press to Press', 'Work hours in Press stage', 'Clock hours Pre Press to Press', 'Clock hours in Press stage', 'Work days Pre Press to Press', 'Work days in Press stage', 'Current/last stage', 'Times sent back to Not Approved', 'Dates entered by hand (no time)'],
    summary(opts).map((r) => [r.job, r.item, r.description, r.dateDue || '', r.customer, r.title, r.csrName || csrName(r.csrNo), r.press, local(r.firstSeenAt), r.firstStage, when(r, 'approved'), when(r, 'prePress'), when(r, 'press'), when(r, 'leftPress'), r.leftPressTo || '', local(r.shippedAt), workHours(r.prePressAt, r.pressAt), workHours(r.pressAt, r.leftPressAt), hours(r.prePressAt, r.pressAt), hours(r.pressAt, r.leftPressAt), days(r, 'prePress', 'press'), days(r, 'press', 'leftPress'), r.stage, r.sentBack || 0, (r.manualDates || []).join(', ')]),
  );
}

// ---------- hand-entered dates ----------
function saveManual() {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const tmp = MANUAL_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(manual, null, 1));
  fs.renameSync(tmp, MANUAL_FILE);
}
function milestoneOf(word) {
  const w = String(word || '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!w) return null;
  if (/^(left press|off press|printed|out of press|production|done printing)/.test(w)) return 'leftPress';
  if (/^(not approved|approved|approval|approve)/.test(w)) return 'approved';
  if (/^(pre ?press|prepress)/.test(w)) return 'prePress';
  if (/^(press|on press|to press|indigo|ricoh|konica)/.test(w)) return 'press';
  return null;
}
// "10/14", "10/14/26", "10/14/2026", "2026-10-14" -> "2026-10-14"
function parseDate(s) {
  s = String(s || '').trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = /^(\d{1,2})[\/.-](\d{1,2})(?:[\/.-](\d{2,4}))?$/.exec(s);
  if (!m) return null;
  const today = local(new Date().toISOString()).slice(0, 10);
  let y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : +today.slice(0, 4);
  let d = `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  if (!m[3] && d > today) d = `${y - 1}${d.slice(4)}`; // no year given and it would be in the future: last year
  const t = new Date(d + 'T12:00:00Z');
  return isNaN(t) || t.toISOString().slice(0, 10) !== d ? null : d;
}

// Accepts text pasted from Excel or a CSV, in either shape:
//   one row per job, with a header:   Job | Item | Approved | Pre Press | Press | Left Press
//   one row per date:                 267130, Pre Press, 10/14   (optional item: 267130, 2, Press, 10/15)
function importManual(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const split = (l) => (l.includes('\t') ? l.split('\t') : l.split(',')).map((c) => c.trim().replace(/^"|"$/g, ''));
  const added = [], errors = [];
  const put = (job, item, milestone, date, line) => {
    manual[`${job}/${item ?? '*'}/${milestone}`] = { job, item, milestone, date, addedAt: new Date().toISOString() };
    added.push({ job, item, stage: MILESTONES[milestone], date, line });
  };
  if (!lines.length) return { added, errors: ['Nothing to import.'] };
  const head = split(lines[0]);
  const cols = head.map(milestoneOf);
  const jobCol = head.findIndex((h) => /^(job|job ?#|job ?no|job number)$/i.test(h));
  const itemCol = head.findIndex((h) => /^item/i.test(h));
  if (cols.some(Boolean) && jobCol >= 0) {
    lines.slice(1).forEach((l, i) => {
      const c = split(l), job = parseInt(c[jobCol], 10), item = itemCol >= 0 && c[itemCol] ? parseInt(c[itemCol], 10) : null;
      if (!job) return errors.push(`Line ${i + 2}: no job number`);
      cols.forEach((ms, k) => {
        if (!ms || !c[k]) return;
        const d = parseDate(c[k]);
        if (d) put(job, item, ms, d, i + 2); else errors.push(`Line ${i + 2}: "${c[k]}" isn't a date`);
      });
    });
  } else {
    lines.forEach((l, i) => {
      // Free-form: any separators. Job = 5+ digit number, date = first date-looking token,
      // stage = the words left over, item = a 1-3 digit number (optional).
      const tokens = l.split(/[\s,;|]+/).filter(Boolean);
      const dateTok = tokens.find((x) => parseDate(x));
      const jobTok = tokens.find((x) => /^#?\d{5,}$/.test(x));
      if (i === 0 && !jobTok) return; // header row
      const rest = tokens.filter((x) => x !== dateTok && x !== jobTok);
      const itemTok = rest.find((x) => /^(item)?#?\d{1,3}$/i.test(x));
      const ms = milestoneOf(rest.filter((x) => x !== itemTok && !/^item$/i.test(x)).join(' '));
      if (!jobTok) return errors.push(`Line ${i + 1}: no job number`);
      if (!ms) return errors.push(`Line ${i + 1}: no stage (use Approved, Pre Press, Press or Left Press)`);
      if (!dateTok) return errors.push(`Line ${i + 1}: no date`);
      put(parseInt(jobTok.replace('#', ''), 10), itemTok ? parseInt(itemTok.replace(/\D/g, ''), 10) : null, ms, parseDate(dateTok), i + 1);
    });
  }
  if (added.length) saveManual();
  return { added, errors };
}
function listManual() { return Object.values(manual).sort((a, b) => a.job - b.job || a.milestone.localeCompare(b.milestone)); }
function removeManual(key) { if (key === '*') manual = {}; else delete manual[key]; saveManual(); }

module.exports = { workHours, workDays, importManual, listManual, removeManual, localMidnightIso, init, observe, closed, list, summary, eventsCsv, summaryCsv, local, count: () => events.length, since: () => (events[0] ? events[0].at : null) };
