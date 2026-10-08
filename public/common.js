// Shared helpers for the office and TV views.
const MSD = (() => {
  const DAY = 86400000;
  const parse = (d) => (d ? Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) : NaN);
  const iso = (t) => new Date(t).toISOString().slice(0, 10);
  const addDays = (d, n) => iso(parse(d) + n * DAY);
  const dow = (d) => new Date(parse(d)).getUTCDay(); // 0 Sun … 6 Sat
  const diffDays = (a, b) => Math.round((parse(a) - parse(b)) / DAY);
  const isWeekend = (d) => dow(d) === 0 || dow(d) === 6;
  function nextWorkday(d) { let x = addDays(d, 1); while (isWeekend(x)) x = addDays(x, 1); return x; }
  function weekStart(d) { const w = dow(d); return addDays(d, w === 0 ? -6 : 1 - w); } // Monday

  const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const fmtShort = (d) => (d ? `${+d.slice(5, 7)}/${+d.slice(8, 10)}` : '—');
  const fmtDay = (d) => (d ? `${WD[dow(d)]} ${+d.slice(5, 7)}/${+d.slice(8, 10)}` : '—');
  const fmtLong = (d) => (d ? `${WD[dow(d)]}, ${MO[+d.slice(5, 7) - 1]} ${+d.slice(8, 10)}` : '—');
  const money = (v) => (v ? '$' + Math.round(v).toLocaleString('en-US') : '—');
  const moneyK = (v) => (v >= 10000 ? '$' + (v / 1000).toFixed(v >= 100000 ? 0 : 1) + 'k' : money(v || 0).replace('—', '$0'));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ----- labels (code → name), falling back to the number -----
  let L = {};
  const lab = (group, code, prefix) => {
    const v = L[group] && L[group][String(code)];
    return v || (prefix ? `${prefix} ${code}` : String(code));
  };
  const jobStage = (j) => lab('jobStatus', j.status, 'Status');
  const mainLine = (j) => (j.items || []).find((i) => i.serNo === 0) || null;
  const itemStage = (j) => { const m = mainLine(j); return m ? lab('itemStatus', m.status, 'Item status') : '—'; };
  const person = (group, code) => (code ? lab(group, code, '#') : '—');

  // ----- classify an open job relative to today -----
  function bucket(j, today) {
    if (!j.dateDue) return 'nodate';
    const d = diffDays(j.dateDue, today);
    if (d < 0) return 'late';
    if (d === 0) return 'today';
    if (j.dateDue === nextWorkday(today) || d === 1) return 'next';
    if (d <= 7) return 'week';
    return 'later';
  }
  const BUCKET_NAMES = { late: 'Late', today: 'Due today', next: 'Next workday', week: 'Next 7 days', later: 'Later', nodate: 'No due date' };

  const ICONS = {
    late: '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 1.5 15 14H1L8 1.5Zm-.75 4.5v4h1.5V6h-1.5Zm0 5v1.5h1.5V11h-1.5Z"/></svg>',
    today: '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 4.5V8l2.5 1.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  };

  function dueBadge(j, today) {
    const b = bucket(j, today);
    if (b === 'late') { const n = -diffDays(j.dateDue, today); return `<span class="badge late">${ICONS.late}${n}d late</span>`; }
    if (b === 'today') return `<span class="badge today">${ICONS.today}Today</span>`;
    return '';
  }

  async function load() {
    const res = await fetch('/api/data', { cache: 'no-store' });
    if (res.status === 401) { location.href = '/login?next=' + encodeURIComponent(location.pathname); throw new Error('login'); }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    L = data.labels || {};
    const hidden = new Set((L.hiddenJobStatuses || []).map(String));
    data.open = data.open.filter((j) => !hidden.has(String(j.status)));
    return data;
  }

  // Ordered list of stages present in the data, honouring labels.stageOrder when given.
  function stageList(jobs, keyFn) {
    const counts = new Map();
    for (const j of jobs) counts.set(keyFn(j), (counts.get(keyFn(j)) || 0) + 1);
    const order = (L.stageOrder || []).map(String);
    return [...counts.entries()].sort((a, b) => {
      const ia = order.indexOf(a[0]), ib = order.indexOf(b[0]);
      if (ia !== -1 || ib !== -1) return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
      return a[0].localeCompare(b[0], undefined, { numeric: true });
    });
  }

  function scanPill(scan) {
    const bf = scan.backfill;
    let cls = '', text = 'Live';
    if (scan.lastErrorAt && (!scan.lastOkAt || scan.lastErrorAt > scan.lastOkAt)) { cls = 'err'; text = 'Can’t reach Printer’s Plan'; }
    else if (bf && !bf.done) { cls = 'warn'; text = `Initial scan ${Math.round(bf.progress * 100)}%`; }
    else if (!scan.lastCycleAt) { cls = 'warn'; text = 'Starting…'; }
    const when = scan.lastCycleAt ? new Date(scan.lastCycleAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
    return `<span class="scan-pill ${cls}" title="Newest job #${scan.newestJobNo || '?'}${scan.lastError ? ' · last error: ' + esc(scan.lastError) : ''}"><span class="dot"></span>${text}${when && !cls ? ' · updated ' + when : ''}</span>`;
  }

  // Shared floating tooltip
  let tipEl;
  function tip(e, html) {
    if (!tipEl) { tipEl = document.createElement('div'); tipEl.className = 'tooltip'; document.body.appendChild(tipEl); }
    if (!html) { tipEl.style.display = 'none'; return; }
    tipEl.innerHTML = html; tipEl.style.display = 'block';
    const r = tipEl.getBoundingClientRect();
    let x = e.clientX + 14, y = e.clientY - r.height - 10;
    if (x + r.width > innerWidth - 8) x = e.clientX - r.width - 14;
    if (y < 8) y = e.clientY + 16;
    tipEl.style.left = x + 'px'; tipEl.style.top = y + 'px';
  }

  return { parse, addDays, diffDays, isWeekend, nextWorkday, weekStart, fmtShort, fmtDay, fmtLong, money, moneyK, esc, lab, jobStage, itemStage, mainLine, person, bucket, BUCKET_NAMES, ICONS, dueBadge, load, stageList, scanPill, tip };
})();
