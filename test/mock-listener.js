// A fake Printer's Plan listener with made-up jobs, for testing the dashboard locally:
//   node test/mock-listener.js            (listens on :4100)
//   LISTENER_URL=http://localhost:4100/planweb/Listener.aspx DASHBOARD_PASSWORD=test npm start
const http = require('http');
const PORT = Number(process.env.MOCK_PORT || 4100);
const NEWEST = 267200;
const today = new Date(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date()) + 'T00:00:00Z');
const day = (offset) => new Date(today.getTime() + offset * 86400000).toISOString().slice(0, 10) + 'T00:00:00-07:00';

let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const CUSTOMERS = ['Riverbend Running Club', 'Cascade Tri Series', 'Northside Bakery', 'Summit Dental', 'Willamette Youth Soccer', 'Green Valley Farms', 'Harbor Credit Union', 'Pine Street Cafe', 'Lakeside School District', 'Copperline Brewing'];
const PRODUCTS = ['RACE BIBS - TYVEK', 'VINYL BANNER 3x6', 'BUSINESS CARDS', 'POSTCARDS 4x6', 'TRIFOLD BROCHURE', 'STOCK BIBS', 'POSTER 18x24', 'BAG TAGS', 'WINDOW DECALS', 'NCR FORMS', 'YARD SIGNS', 'FINISHER CARDS'];

const jobs = {};
for (let n = NEWEST - 2200; n <= NEWEST; n++) {
  const r = rnd();
  if (r < 0.04) continue; // unused number
  const age = Math.floor((NEWEST - n) / 9); // ~9 jobs a day
  const openChance = n > NEWEST - 150 ? 0.85 : n > NEWEST - 600 ? 0.06 : 0.008;
  const isOpen = rnd() < openChance;
  const dueOffset = isOpen ? Math.floor(rnd() * 16) - 4 - (n < NEWEST - 150 ? 6 : 0) : -age + 3;
  jobs[n] = {
    jobNo: n, type: isOpen ? 0 : 3, title: pick(PRODUCTS) + (rnd() < 0.3 ? ' - REPRINT' : ''), customer: pick(CUSTOMERS),
    status: isOpen ? pick([0, 0, 0, 1, 2, 5]) : 0, csr: pick([101, 102, 103]), rep: pick([200, 201, 203]),
    dateIn: day(-age), dateDue: rnd() < 0.04 ? '' : day(dueOffset), dateShipped: isOpen ? '' : day(-age + Math.floor(rnd() * 5)),
    subtotal: rnd() < 0.3 ? 0.0001 : Math.round(rnd() * 2500 * 100) / 100, itemStatus: pick([0, 2, 3, 4, 5, 17]),
  };
}

function xml(j) {
  return `<job JobID="${j.jobNo - 225000}" JobNo="${j.jobNo}">
\t<JOB_1>
\t\t<JOB_1>
\t\t\t<JobID>${j.jobNo - 225000}</JobID>
\t\t\t<JobType>${j.type}</JobType>
\t\t\t<JobNo>${j.jobNo}</JobNo>
\t\t\t<Title>${j.title.replace(/&/g, '&amp;')}</Title>
\t\t\t<Status>${j.status}</Status>
\t\t\t<CSRNo>${j.csr}</CSRNo>
\t\t\t<SRepNo>${j.rep}</SRepNo>
\t\t\t<CusNo>1234</CusNo>
\t\t\t<PO>PO ${j.jobNo % 9973}</PO>
\t\t\t<DateIn>${j.dateIn}</DateIn>
${j.dateDue ? `\t\t\t<DateDue>${j.dateDue}</DateDue>\n` : ''}${j.dateShipped ? `\t\t\t<DateShipped>${j.dateShipped}</DateShipped>\n` : ''}\t\t\t<Cost>10.00</Cost>
\t\t\t<Subtotal>${j.subtotal}</Subtotal>
\t\t\t<Balance>0.0000</Balance>
\t\t\t<WOrderPrinted>1</WOrderPrinted>
\t\t\t<WOrderNote>Test note for ${j.jobNo}
Ship by Standard Shipping</WOrderNote>
\t\t</JOB_1>
\t</JOB_1>
\t<BILLTO_ADDRESS>
\t\t<BILLTO_ADDRESS>
\t\t\t<Name>${j.customer}</Name>
\t\t</BILLTO_ADDRESS>
\t</BILLTO_ADDRESS>
\t<SHIPTO_ADDRESS>
\t\t<SHIPTO_ADDRESS>
\t\t\t<Attention>Pick up Mon-Fri 9am-3pm</Attention>
\t\t\t<Company>Will Call</Company>
\t\t</SHIPTO_ADDRESS>
\t</SHIPTO_ADDRESS>
\t<BUYER_INFO>
\t\t<BUYER_INFO>
\t\t\t<Name>Test Buyer</Name>
\t\t</BUYER_INFO>
\t</BUYER_INFO>
\t<ITEMS_TBL>
\t\t<ITEMS_TBL>
\t\t\t<ItemID>1</ItemID>
\t\t\t<Description>${j.title}</Description>
\t\t\t<SerNo>0</SerNo>
\t\t\t<ItemNo>1</ItemNo>
\t\t\t<SubNo>0</SubNo>
\t\t\t<Status>${j.itemStatus}</Status>
\t\t\t<EmpNo>0</EmpNo>
\t\t\t<ChargeQty>500</ChargeQty>
\t\t\t<Price>${j.subtotal}</Price>
\t\t</ITEMS_TBL>
\t\t<ITEMS_TBL>
\t\t\t<ItemID>2</ItemID>
\t\t\t<SerNo>474</SerNo>
\t\t\t<ItemNo>1</ItemNo>
\t\t\t<SubNo>0</SubNo>
\t\t\t<Status>1</Status>
\t\t\t<EmpNo>3</EmpNo>
\t\t\t<ChargeQty>1</ChargeQty>
\t\t</ITEMS_TBL>
\t</ITEMS_TBL>
</job>`;
}

let count = 0;
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  count++;
  setTimeout(() => {
    if (!req.headers.referer) return res.end('PW_MISSING_REFERRER');
    const q = u.searchParams;
    if (q.get('todo') !== 'GetJob') return res.end('PW_ERROR_TODO_UNKNOWN');
    const j = jobs[Number(q.get('jobno'))];
    const want = { Order: 0, History: 3 }[q.get('type')];
    res.end(j && j.type === want ? xml(j) : '');
  }, 15);
}).listen(PORT, () => console.log(`mock listener on :${PORT} (${Object.values(jobs).filter((j) => !j.type).length} open jobs, newest #${NEWEST})`));
setInterval(() => process.env.MOCK_VERBOSE && console.log('requests', count), 5000);
