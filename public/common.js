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
  function prevWorkday(d) { let x = addDays(d, -1); while (isWeekend(x)) x = addDays(x, -1); return x; }
  // A weekend date counted on the next weekday (due dates) or the weekday before (ship dates).
  const workdayOf = (d) => (isWeekend(d) ? nextWorkday(d) : d);
  const workdayBefore = (d) => (isWeekend(d) ? prevWorkday(d) : d);
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
  // A job's stage = the LOWEST status among its product lines (service/operation lines are ignored),
  // so a job with lines at 2 and 5 shows as 2 until every line has moved on.
  // Any statuses listed in labels.ignoreItemStatuses are skipped (none by default).
  const ignored = (code) => (L.ignoreItemStatuses || []).map(Number).includes(code);
  const stageCode = (j) => {
    const codes = (j.items || []).filter((i) => i.serNo === 0 && !ignored(i.status)).map((i) => i.status);
    return codes.length ? Math.min(...codes) : null;
  };
  const stage = (j) => { const c = stageCode(j); return c === null ? '' : lab('itemStatus', c, 'Status'); };
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

  // "Need by" date, typed into the work order note as e.g. "NB 10/09/26" (year optional).
  // Returns 'YYYY-MM-DD' or null.
  function needBy(j) {
    if (j._nb !== undefined) return j._nb;
    const m = /\bNB\s*[:\-]?\s*(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?/i.exec(j.workOrderNote || '');
    let out = null;
    if (m) {
      const mo = +m[1], d = +m[2];
      let y = m[3] ? +m[3] : +(j.dateIn || '').slice(0, 4) || new Date().getFullYear();
      if (y < 100) y += 2000;
      if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
        out = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        // Lands well before the job came in: no year typed means next year; a typed year that's
        // way off (e.g. "10/11/24" on a job entered in 2026) is a typo, so use the job's year.
        if (j.dateIn && diffDays(out, j.dateIn) < -60) {
          const jy = +j.dateIn.slice(0, 4);
          out = `${m[3] ? jy : y + 1}${out.slice(4)}`;
          if (diffDays(out, j.dateIn) < -60) out = `${+out.slice(0, 4) + 1}${out.slice(4)}`;
        }
      }
    }
    j._nb = out;
    return out;
  }
  // What was typed after "NB" when it isn't a full date (e.g. "NB 11/?"), for display only.
  function needByText(j) {
    const m = /\bNB\b[ \t:]*([^\r\n|]{0,12})/i.exec(j.workOrderNote || '');
    return m && m[1].trim() ? 'NB ' + m[1].trim() : '';
  }
  // Jobs with no NB date come first, then earliest NB date.
  function cmpNeedBy(a, b) {
    const x = needBy(a), y = needBy(b);
    if (!x && !y) return 0;
    if (!x) return -1;
    if (!y) return 1;
    return x < y ? -1 : x > y ? 1 : 0;
  }
  // Standard order: due date, then NB date (no NB first), then job number.
  function cmpDueThenNB(a, b) {
    const x = a.dateDue || '9999', y = b.dateDue || '9999';
    return (x < y ? -1 : x > y ? 1 : 0) || cmpNeedBy(a, b) || a.jobNo - b.jobNo;
  }

  // Dollar figures use the job total (incl. discounts, shipping, tax); older cached records fall back to subtotal.
  const amount = (j) => (j.total ?? j.subtotal ?? 0);

  // Any job with "reprint" in its title gets flagged red everywhere.
  const isReprint = (j) => /reprint/i.test(j.title || '');
  const REPRINT_BADGE = '<span class="badge reprint">Reprint</span> ';

  async function load() {
    const key = new URLSearchParams(location.search).get('key');
    const res = await fetch('/api/data' + (key ? '?key=' + encodeURIComponent(key) : ''), { cache: 'no-store' });
    if (res.status === 401) { location.href = '/login?next=' + encodeURIComponent(location.pathname); throw new Error('login'); }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    L = data.labels || {};
    const hidden = new Set((L.hiddenJobStatuses || []).map(String));
    data.open = data.open.filter((j) => !hidden.has(String(j.status)));
    return data;
  }

  // Jobs that count as "due" on a day: due that day (weekend due dates count on Monday when
  // foldWeekends is set) and NOT shipped before that day. Jobs that shipped early drop out
  // of that day's total, matching how the shop counts "due today".
  function jobsDueOn(data, day, foldWeekends) {
    const openNos = new Set(data.open.map((j) => j.jobNo));
    const every = [...data.open, ...(data.invoiced || []).filter((j) => !openNos.has(j.jobNo))];
    return every.filter((j) => {
      if (!j.dateDue) return false;
      const due = foldWeekends ? workdayOf(j.dateDue) : j.dateDue;
      if (due !== day) return false;
      return !(j.dateShipped && workdayBefore(j.dateShipped) < day);
    });
  }

  // "Left / total" for today: jobs still open and due today, out of every job due today that
  // didn't ship early (open + shipped today). Returns HTML like 7<span class="of">/41</span>.
  function dueTodayFraction(data) {
    const t = data.today;
    const left = data.open.filter((j) => j.dateDue === t).length;
    const total = jobsDueOn(data, t, false).length;
    return `${left}<span class="of">/${total}</span>`;
  }

  // ---------- half-circle goal gauge (SVG) ----------
  // Bands are fractions of the target: red < 50%, orange 50-75%, yellow 75-90%, green 90%+.
  // The scale runs 0 → target, or a bit past the value when the target has been beaten.
  const GAUGE_BANDS = [[0, 0.5, '#dd4b5a'], [0.5, 0.75, '#e98f3e'], [0.75, 0.9, '#f6e46a'], [0.9, Infinity, '#74b27d']];
  function gaugeSvg(value, target) {
    const cx = 120, cy = 118, r = 82, w = 34;
    const max = Math.max(target || 1, value > target ? value * 1.06 : 0);
    const pt = (f, rad = r) => { const a = Math.PI * (1 - Math.min(1, Math.max(0, f))); return [cx + rad * Math.cos(a), cy - rad * Math.sin(a)]; };
    const arc = (f1, f2) => { const [x1, y1] = pt(f1), [x2, y2] = pt(f2); return `M${x1.toFixed(2)} ${y1.toFixed(2)} A${r} ${r} 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`; };
    const bands = GAUGE_BANDS.map(([a, b, c]) => {
      const f1 = (a * target) / max, f2 = Math.min(1, (Math.min(b, 1e9) * target) / max);
      return f2 > f1 ? `<path d="${arc(f1, b === Infinity ? 1 : f2)}" stroke="${c}" stroke-width="${w}" fill="none"/>` : '';
    }).join('');
    const tf = target / max;
    const [tx1, ty1] = pt(tf, r - w / 2 - 4), [tx2, ty2] = pt(tf, r + w / 2 + 10);
    const tick = max > target * 1.001
      ? `<line x1="${tx1}" y1="${ty1}" x2="${tx2}" y2="${ty2}" stroke="var(--text-2)" stroke-width="1.5" stroke-dasharray="3 3"/>
         <text x="${tx2}" y="${ty2 - 5}" text-anchor="middle" class="g-lab">${money(target)}</text>`
      : '';
    const [nx, ny] = pt(value / max, r + w / 2 + 2);
    return `<svg viewBox="0 0 240 140" class="gauge-svg" role="img" aria-label="${money(value)} of ${money(target)} target">
      ${bands}${tick}
      <line x1="${cx}" y1="${cy}" x2="${nx.toFixed(2)}" y2="${ny.toFixed(2)}" stroke="var(--text)" stroke-width="6" stroke-linecap="round"/>
      <circle cx="${cx}" cy="${cy}" r="8" fill="var(--text)"/>
      <text x="${cx - r - w / 2}" y="${cy + 16}" class="g-lab">0</text>
      <text x="${cx + r + w / 2}" y="${cy + 16}" text-anchor="end" class="g-lab">${money(max > target * 1.001 ? max : target)}</text>
    </svg>`;
  }

  // The four goal gauge cards (used by the office view and the office TV).
  function renderGauges(el, data) {
    if (!el) return;
    const g = data.gauges || {}, t = data.targets || {};
    const cards = [
      ['Received Today', g.receivedToday, t.receivedToday, 'Jobs entered today'],
      ['Shipped Today', g.shippedToday, t.shippedToday, "Jobs with today's ship date"],
      ['Shipped This Month', g.shippedMonth, t.shippedMonth, 'Since the 1st'],
      ['Shipped This Year', g.shippedYear, t.shippedYear, g.yearHistoryLoaded ? 'Since January 1' : "Still loading this year's history…"],
    ];
    el.innerHTML = cards.map(([label, v = 0, target = 0, note]) => `
      <div class="card gauge">
        <h3>${label}</h3>
        ${gaugeSvg(v, target)}
        <div class="g-value num">${money(v).replace('—', '$0')}</div>
        <div class="g-foot">${target ? Math.round((v / target) * 100) + '% of ' + money(target) + ' target' : 'No target set'}<span class="g-note"> · ${note}</span></div>
      </div>`).join('');
  }

  // Stage colours come from labels.stageColors (by stage name). Chips use dark text since
  // the colours are bright.
  const stageColor = (name) => (L.stageColors || {})[name] || '';
  function stageChip(name) {
    if (!name) return '';
    const c = stageColor(name);
    return `<span class="stage${c ? ' coloured' : ''}"${c ? ` style="background:${esc(c)}"` : ''}>${esc(name)}</span>`;
  }

  // Stages present in the data as [name, count, code], in labels.stageOrder order if given,
  // otherwise by status number.
  function stageList(jobs) {
    const by = new Map();
    for (const j of jobs) {
      const name = stage(j), code = stageCode(j);
      if (!name) continue; // nothing to show (e.g. only status-13 lines)
      const e = by.get(name) || { n: 0, code };
      e.n++; e.code = Math.min(e.code, code); by.set(name, e);
    }
    const order = (L.stageOrder || []).map(String);
    return [...by.entries()].map(([name, e]) => [name, e.n, e.code]).sort((a, b) => {
      const ia = order.indexOf(a[0]), ib = order.indexOf(b[0]);
      if (ia !== -1 || ib !== -1) return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
      return (a[2] ?? 999) - (b[2] ?? 999);
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

  return { renderGauges, gaugeSvg, jobsDueOn, dueTodayFraction, stageColor, stageChip, ignored, stage, stageCode, amount, prevWorkday, workdayOf, workdayBefore, needBy, needByText, cmpNeedBy, cmpDueThenNB, isReprint, REPRINT_BADGE, parse, addDays, diffDays, isWeekend, nextWorkday, weekStart, fmtShort, fmtDay, fmtLong, money, moneyK, esc, lab, jobStage, itemStage, mainLine, person, bucket, BUCKET_NAMES, ICONS, dueBadge, load, stageList, scanPill, tip };
})();
