(() => {
  const M = MSD, $ = (id) => document.getElementById(id);
  const store = { get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };

  let data = null;
  const f = { q: '', bucket: 'all', stage: '', csr: '', date: '' };
  let sort = { key: 'due', dir: 1 };
  const expanded = new Set();

  const stageOf = M.stage; // lowest product-line status on the job

  // ---------------- KPIs ----------------
  function renderKpis(open, inv, today) {
    const by = (b) => open.filter((j) => M.bucket(j, today) === b).length;
    const nw = M.nextWorkday(today);
    const wk = M.weekStart(today), mo = today.slice(0, 8) + '01';
    const all = [...open, ...inv];
    const newWeek = all.filter((j) => j.dateIn && j.dateIn >= wk).length;
    const newToday = all.filter((j) => j.dateIn === today).length;
    const shippedWeek = inv.filter((j) => j.dateShipped && j.dateShipped >= wk);
    const shippedMonth = inv.filter((j) => j.dateShipped && j.dateShipped >= mo);
    const sum = (a) => a.reduce((s, j) => s + M.amount(j), 0);
    const tiles = [
      { b: 'late', cls: 'critical', icon: M.ICONS.late, label: 'Late', value: by('late'), foot: 'past due date' },
      { b: 'today', cls: 'warning', icon: M.ICONS.today, label: 'Due today', value: by('today'), foot: M.fmtLong(today) },
      { b: 'next', label: 'Due next workday', value: by('next'), foot: M.fmtLong(nw) },
      { b: 'week', label: 'Due in the next week', value: by('week'), foot: 'after next workday' },
      { b: 'all', label: 'Open jobs', value: open.length, foot: `${by('nodate')} without a due date` },
      { label: 'New orders this week', value: newWeek, foot: `${newToday} entered today` },
      { label: 'Shipped this week', value: M.moneyK(sum(shippedWeek)), foot: `${shippedWeek.length} jobs since Mon` },
      { label: 'Shipped month to date', value: M.moneyK(sum(shippedMonth)), foot: `${shippedMonth.length} jobs` },
    ];
    $('kpis').innerHTML = tiles.map((t) => `
      <div class="kpi ${t.cls || ''}" ${t.b ? `data-bucket="${t.b}" role="button" tabindex="0" title="Show these jobs"` : ''}>
        <div class="label">${t.icon || ''}${t.label}</div>
        <div class="value num">${t.value}</div>
        <div class="foot">${t.foot}</div>
      </div>`).join('');
  }

  // ---------------- workload chart ----------------
  // Late + the next 5 business days (today counts if it's a weekday). Jobs due on a
  // Saturday or Sunday are counted on the following Monday.
  function renderWorkload(open, today) {
    const cols = [{ key: 'late', label: 'Late<br>&nbsp;', jobs: open.filter((j) => M.bucket(j, today) === 'late'), critical: true }];
    let d = M.isWeekend(today) ? M.nextWorkday(today) : today;
    for (let i = 0; i < 5; i++, d = M.nextWorkday(d)) {
      const day = d;
      cols.push({ key: day, label: (day === today ? 'Today' : M.fmtDay(day).split(' ')[0]) + '<br>' + M.fmtShort(day), jobs: open.filter((j) => j.dateDue && j.dateDue >= today && M.workdayOf(j.dateDue) === day), strong: day === today });
    }
    const max = Math.max(1, ...cols.map((c) => c.jobs.length));
    $('workload').innerHTML = `
      <div class="vbars">${cols.map((c, i) => `
        <div class="col" data-i="${i}">
          ${c.jobs.length ? `<div class="val num">${c.jobs.length}</div>` : ''}
          <div class="bar ${c.critical ? 'critical' : ''}" style="height:${(c.jobs.length / max) * 85}%"></div>
          <div class="hit"></div>
        </div>`).join('')}
      </div>
      <div class="vlabels">${cols.map((c) => `<span class="${c.strong || c.critical ? 'strong' : ''}">${c.label}</span>`).join('')}</div>`; // labels are trusted (built from dates)
    $('workload').querySelectorAll('.col').forEach((el) => {
      const c = cols[+el.dataset.i];
      const amt = c.jobs.reduce((s, j) => s + M.amount(j), 0);
      const html = `<b>${c.key === 'late' ? 'Late' : M.fmtLong(c.key)}</b><br>${c.jobs.length} job${c.jobs.length === 1 ? '' : 's'}${amt ? ' · ' + M.money(amt) : ''}<br><span style="opacity:.7">Click to list</span>`;
      el.addEventListener('mousemove', (e) => M.tip(e, html));
      el.addEventListener('mouseleave', (e) => M.tip(e, null));
      el.addEventListener('click', () => {
        if (c.key === 'late') { f.bucket = 'late'; f.date = ''; } else { f.bucket = 'all'; f.date = c.key; }
        render(); $('q').scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    });
  }

  // ---------------- stages ----------------
  function renderStages(open) {
    const list = M.stageList(open);
    const max = Math.max(1, ...list.map((s) => s[1]));
    $('stages').innerHTML = list.length ? `<div class="hbars">${list.map(([name, n]) => `
      <div class="row" data-stage="${M.esc(name)}" title="Show ${M.esc(name)}">
        <div class="name">${M.esc(name)}</div>
        <div class="track"><div class="fill" style="width:${(n / max) * 100}%"></div></div>
        <div class="count num">${n}</div>
      </div>`).join('')}</div>` : '<p class="hint">No open jobs yet.</p>';
    $('stages').querySelectorAll('.row').forEach((el) => el.addEventListener('click', () => { f.stage = el.dataset.stage; render(); }));
  }

  // ---------------- sales chart ----------------
  // The last 10 business days, ending today (or the last weekday if today is a weekend).
  // Anything shipped on a Saturday or Sunday is counted on the Friday before.
  function renderSales(inv, today, scan) {
    const days = [];
    let d = M.isWeekend(today) ? M.prevWorkday(today) : today;
    for (let i = 0; i < 10; i++, d = M.prevWorkday(d)) days.unshift(d);
    const cols = days.map((day) => {
      const jobs = inv.filter((j) => j.dateShipped && M.workdayBefore(j.dateShipped) === day);
      return { d: day, jobs, amt: jobs.reduce((s, j) => s + M.amount(j), 0) };
    });
    const max = Math.max(1, ...cols.map((c) => c.amt));
    $('sales').innerHTML = `
      <div class="vbars" style="height:110px">${cols.map((c, i) => `
        <div class="col" data-i="${i}">
          ${c.amt ? `<div class="val num">${M.moneyK(c.amt)}</div>` : ''}
          <div class="bar" style="height:${(c.amt / max) * 82}%"></div>
          <div class="hit"></div>
        </div>`).join('')}
      </div>
      <div class="vlabels">${cols.map((c) => `<span class="${c.d === today ? 'strong' : ''}">${c.d === today ? 'Today' : M.fmtDay(c.d).split(' ')[0]}<br>${M.fmtShort(c.d)}</span>`).join('')}</div>`;
    $('sales').querySelectorAll('.col').forEach((el) => {
      const c = cols[+el.dataset.i];
      const html = `<b>${M.fmtLong(c.d)}</b><br>${M.money(c.amt).replace('—', '$0')} · ${c.jobs.length} job${c.jobs.length === 1 ? '' : 's'}`;
      el.addEventListener('mousemove', (e) => M.tip(e, html));
      el.addEventListener('mouseleave', (e) => M.tip(e, null));
    });
    const bf = scan.backfill;
    $('salesHint').textContent = 'Job total by date shipped · last 10 business days' + (bf && !bf.done ? ' · still loading history, totals will fill in' : '');
  }

  // ---------------- table ----------------
  const COLS = [
    { key: 'job', label: 'Job #', val: (j) => j.jobNo },
    { key: 'due', label: 'Due', val: (j) => j.dateDue || '9999' },
    { key: 'nb', label: 'Need by', val: (j) => M.needBy(j) || '' },
    { key: 'title', label: 'Customer / title', val: (j) => (j.customer || '').toLowerCase() },
    { key: 'stage', label: 'Stage', val: (j) => M.stageCode(j) ?? 999 },
    { key: 'csr', label: 'CSR', val: (j) => M.person('csr', j.csrNo) },
    { key: 'amt', label: 'Amount', val: (j) => M.amount(j), right: true },
  ];

  function fillSelect(el, label, values, current) {
    el.innerHTML = `<option value="">${label}: all</option>` + values.map((v) => `<option ${v === current ? 'selected' : ''}>${M.esc(v)}</option>`).join('');
  }

  function renderTable(open, today) {
    const chips = [['all', 'All'], ['late', 'Late'], ['today', 'Today'], ['next', 'Next workday'], ['week', 'Next 7 days'], ['nodate', 'No due date']];
    $('chips').innerHTML = chips.map(([k, l]) => `<button class="chip" data-b="${k}" aria-pressed="${f.bucket === k && !f.date}">${l}</button>`).join('')
      + (f.date ? `<button class="chip" data-b="clear-date" aria-pressed="true">Due ${M.fmtDay(f.date)} ✕</button>` : '');
    fillSelect($('fStage'), 'Stage', M.stageList(open).map((s) => s[0]), f.stage);
    fillSelect($('fCsr'), 'CSR', [...new Set(open.map((j) => M.person('csr', j.csrNo)))].sort(), f.csr);

    const q = f.q.trim().toLowerCase();
    let rows = open.filter((j) =>
      (f.bucket === 'all' || M.bucket(j, today) === f.bucket) &&
      (!f.date || (j.dateDue && M.workdayOf(j.dateDue) === f.date)) &&
      (!f.stage || stageOf(j) === f.stage) &&
      (!f.csr || M.person('csr', j.csrNo) === f.csr) &&
      (!q || [j.jobNo, j.title, j.customer, j.po, j.buyer, j.shipTo].join(' ').toLowerCase().includes(q)));
    const col = COLS.find((c) => c.key === sort.key);
    rows.sort((a, b) => {
      // Need-by column: no NB first, then by date, then due date.
      if (sort.key === 'nb') return M.cmpNeedBy(a, b) * sort.dir || (a.dateDue || '9999').localeCompare(b.dateDue || '9999') || a.jobNo - b.jobNo;
      const x = col.val(a), y = col.val(b);
      // Ties (e.g. same due date) fall back to NB date (no NB first), then job number.
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir || M.cmpNeedBy(a, b) || a.jobNo - b.jobNo;
    });
    $('countNote').textContent = `${rows.length} of ${open.length} jobs`;

    $('thead').innerHTML = COLS.map((c) => `<th data-k="${c.key}" class="${c.right ? 'right' : ''}" aria-sort="${sort.key === c.key ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none'}">${c.label}</th>`).join('');
    $('rows').innerHTML = rows.map((j) => {
      const b = M.bucket(j, today);
      const rp = M.isReprint(j);
      const tr = `<tr class="job${rp ? ' reprint' : ''}" data-j="${j.jobNo}">
        <td class="num">${j.jobNo}</td>
        <td><span class="due ${b === 'late' || b === 'today' ? b : ''}">${M.fmtDay(j.dateDue)}</span> ${M.dueBadge(j, today)}</td>
        <td class="nb-cell">${M.needBy(j) ? `<b>${M.fmtDay(M.needBy(j))}</b>` : `<span class="muted">${M.esc(M.needByText(j)) || '—'}</span>`}</td>
        <td class="title"><div>${rp ? M.REPRINT_BADGE : ''}${M.esc(j.title)}</div><div class="cust">${M.esc(j.customer)}</div></td>
        <td>${stageOf(j) ? `<span class="stage">${M.esc(stageOf(j))}</span>` : ''}</td>
        <td>${M.esc(M.person('csr', j.csrNo))}</td>
        <td class="num right">${M.money(M.amount(j))}</td>
      </tr>`;
      return tr + (expanded.has(j.jobNo) ? detail(j) : '');
    }).join('') || `<tr><td colspan="7" class="hint" style="padding:20px">No jobs match.</td></tr>`;
  }

  function detail(j) {
    const lines = (j.items || []).map((i) => {
      const what = i.serNo === 0 ? `<b>${M.esc(i.description || 'Item ' + i.itemNo)}</b>${i.qty ? ' · qty ' + i.qty.toLocaleString() : ''}` : `${M.esc(M.lab('service', i.serNo, 'Service'))}${i.empNo ? ' · ' + M.esc(M.person('employee', i.empNo)) : ''}`;
      return `<div class="item"><span class="k">Line ${i.itemNo}${i.subNo ? '.' + i.subNo : ''}</span><span>${what}</span>${i.serNo === 0 && M.ignored(i.status) ? '' : `<span class="stage">${M.esc(M.lab('itemStatus', i.status, 'Status'))}</span>`}</div>`;
    }).join('');
    return `<tr class="detail"><td colspan="7">
      <div style="display:flex;gap:28px;flex-wrap:wrap;font-size:12px;color:var(--text-2)">
        ${j.buyer ? `<span>Ordered by <b>${M.esc(j.buyer)}</b></span>` : ''}
        ${j.po ? `<span>PO <b>${M.esc(j.po)}</b></span>` : ''}
        ${j.shipTo ? `<span>Ship to <b>${M.esc(j.shipTo)}</b>${j.shipAttention ? ' · ' + M.esc(j.shipAttention) : ''}</span>` : ''}
        ${j.fromJobNo ? `<span>From job <b>#${j.fromJobNo}</b></span>` : ''}
        <span>Work order ${j.workOrderPrinted ? 'printed' : '<b>not printed</b>'}</span>
      </div>
      <div class="items">${lines}</div>
      ${j.workOrderNote ? `<div style="font-size:12px;color:var(--muted)">Work order note</div><pre>${M.esc(j.workOrderNote)}</pre>` : ''}
    </td></tr>`;
  }

  // ---------------- wiring ----------------
  function render() {
    if (!data) return;
    const { open, invoiced, today, scan } = data;
    $('today').textContent = M.fmtLong(today);
    $('scan').innerHTML = M.scanPill(scan);
    const bf = scan.backfill;
    $('banner').innerHTML = bf && !bf.done
      ? `<div class="banner">First-time scan in progress (${Math.round(bf.progress * 100)}% of job #${bf.from}–#${bf.to}). Older open jobs will keep appearing until it finishes.</div>` : '';
    renderKpis(open, invoiced, today);
    renderWorkload(open, today);
    renderStages(open);
    renderSales(invoiced, today, scan);
    renderTable(open, today);
  }

  document.addEventListener('click', (e) => {
    const k = e.target.closest('.kpi[data-bucket]');
    if (k) { f.bucket = k.dataset.bucket; f.date = ''; render(); $('q').scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
    const chip = e.target.closest('.chip');
    if (chip) { if (chip.dataset.b === 'clear-date') f.date = ''; else { f.bucket = chip.dataset.b; f.date = ''; } render(); return; }
    const th = e.target.closest('th[data-k]');
    if (th) { sort = sort.key === th.dataset.k ? { key: sort.key, dir: -sort.dir } : { key: th.dataset.k, dir: 1 }; render(); return; }
    const tr = e.target.closest('tr.job');
    if (tr) { const n = +tr.dataset.j; expanded.has(n) ? expanded.delete(n) : expanded.add(n); render(); }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('.kpi[data-bucket]')) e.target.click(); });
  $('q').addEventListener('input', (e) => { f.q = e.target.value; render(); });
  $('fStage').addEventListener('change', (e) => { f.stage = e.target.value; render(); });
  $('fCsr').addEventListener('change', (e) => { f.csr = e.target.value; render(); });

  async function refresh() {
    try { data = await M.load(); render(); }
    catch (err) { if (err.message !== 'login') $('scan').innerHTML = `<span class="scan-pill err"><span class="dot"></span>Dashboard offline — retrying</span>`; }
  }
  refresh();
  setInterval(refresh, 60000);
})();
