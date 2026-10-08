(() => {
  const M = MSD, $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const stageOf = params.get('stage') === 'item' ? M.itemStage : M.jobStage;
  const PAGE_SECONDS = Number(params.get('page')) || 12;
  let data = null;
  const offsets = {}; // column key -> scroll offset in px

  function tick() {
    $('clock').textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function jobRow(j, today, showLate) {
    const lateBy = showLate ? -M.diffDays(j.dateDue, today) : 0;
    const rp = M.isReprint(j);
    return `<div class="tv-job${rp ? ' reprint' : ''}">
      <div class="no">${j.jobNo}</div>
      <div class="t">${rp ? M.REPRINT_BADGE : ''}${M.esc(j.title || '(no title)')}</div>
      <div class="m">
        ${lateBy ? `<span class="lateby">${lateBy}d late</span>` : ''}
        <span>${M.esc(j.customer || '')}</span>
        ${j.csrNo ? `<span>${M.esc(M.person('csr', j.csrNo))}</span>` : ''}
        <span class="stage">${M.esc(stageOf(j))}</span>
      </div>
    </div>`;
  }

  function render() {
    if (!data) return;
    const { open, today, scan } = data;
    $('date').textContent = M.fmtLong(today);
    $('scan').innerHTML = M.scanPill(scan);
    const nw = M.nextWorkday(today);
    const late = open.filter((j) => M.bucket(j, today) === 'late').sort((a, b) => (a.dateDue < b.dateDue ? -1 : 1) || a.jobNo - b.jobNo);
    const due = open.filter((j) => M.bucket(j, today) === 'today').sort((a, b) => a.jobNo - b.jobNo);
    const next = open.filter((j) => j.dateDue === nw).sort((a, b) => a.jobNo - b.jobNo);
    const week = open.filter((j) => j.dateDue && j.dateDue > today && M.diffDays(j.dateDue, today) <= 7).length;

    $('kpis').innerHTML = [
      ['critical', M.ICONS.late, 'Late', late.length],
      ['warning', M.ICONS.today, 'Due today', due.length],
      ['', '', 'Due ' + M.fmtDay(nw), next.length],
      ['', '', 'Open jobs', open.length],
    ].map(([c, i, l, v]) => `<div class="tv-kpi ${c}"><div class="l">${i}${l}</div><div class="v">${v}</div></div>`).join('');

    const cols = [
      { key: 'late', cls: 'late', icon: M.ICONS.late, title: 'Late', jobs: late, late: true },
      { key: 'today', cls: 'today', icon: M.ICONS.today, title: 'Due today', jobs: due },
      { key: 'next', cls: '', icon: '', title: 'Due ' + M.fmtLong(nw), jobs: next },
    ];
    $('cols').innerHTML = cols.map((c) => `
      <section class="tv-col ${c.cls}" data-k="${c.key}">
        <h2>${c.icon}${c.title}<span class="n">${c.jobs.length}</span></h2>
        <div class="viewport"><div class="list">${c.jobs.length ? c.jobs.map((j) => jobRow(j, today, c.late)).join('') : '<div class="empty">Nothing here ✓</div>'}</div></div>
        <div class="page-dots"></div>
      </section>`).join('');
    // Portrait screens stack the lists; give busier lists more of the height.
    document.querySelectorAll('.tv-col').forEach((el, i) => {
      el.style.flexGrow = String(Math.max(1.5, Math.min(cols[i].jobs.length, 10)));
    });
    const stages = M.stageList(open, stageOf);
    $('stages').innerHTML = stages.map(([name, n]) => `<div class="tv-stage"><div class="l">${M.esc(name)}</div><div class="v">${n}</div></div>`).join('');
    applyOffsets(); // after everything is drawn, so list heights are final
  }

  // Page through columns whose list is taller than the screen.
  function applyOffsets(advance = false) {
    document.querySelectorAll('.tv-col').forEach((col) => {
      const k = col.dataset.k, vp = col.querySelector('.viewport'), list = col.querySelector('.list');
      const rows = [...list.children], h = vp.clientHeight;
      let off = offsets[k] || 0;
      if (list.scrollHeight <= h) off = 0;
      else if (advance) {
        const nextRow = rows.find((r) => r.offsetTop + r.offsetHeight > off + h);
        off = nextRow && nextRow.offsetTop > off ? nextRow.offsetTop : 0;
      }
      if (off > list.scrollHeight - 10) off = 0;
      offsets[k] = off;
      list.style.transform = `translateY(${-off}px)`;
      // Hide rows that would be cut off at the bottom (they show on the next page).
      rows.forEach((r) => { r.style.visibility = r.offsetTop + r.offsetHeight > off + h + 1 ? 'hidden' : ''; });
      const first = rows.findIndex((r) => r.offsetTop >= off);
      const visible = rows.filter((r) => r.offsetTop >= off && r.offsetTop + r.offsetHeight <= off + h).length;
      col.querySelector('.page-dots').textContent = list.scrollHeight > h && rows.length ? `${first + 1}–${first + visible} of ${rows.length}` : '';
    });
  }

  async function refresh() {
    try { data = await M.load(); render(); }
    catch (err) { if (err.message !== 'login') $('scan').innerHTML = '<span class="scan-pill err"><span class="dot"></span>Offline — retrying</span>'; }
  }

  tick(); setInterval(tick, 10000);
  refresh(); setInterval(refresh, 60000);
  setInterval(() => applyOffsets(true), PAGE_SECONDS * 1000);
  addEventListener('resize', () => applyOffsets());
})();
