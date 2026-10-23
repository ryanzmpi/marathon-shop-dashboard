// A fake Atlas Dashboard API (GET /api/orders?page=N, GET /api/orders/{id}/jobs) with made-up
// orders shaped like the real GoMake data, for testing:
//   node test/mock-atlas.js      (listens on :4200)
//   ATLAS_URL=http://localhost:4200 npm start
const http = require('http');
const PORT = Number(process.env.MOCK_ATLAS_PORT || 4200);
const pad = (n) => String(n).padStart(2, '0');
const now = new Date();
const utc = (d) => d.toISOString().slice(0, 19);
const created = (daysAgo) => { const d = new Date(now - daysAgo * 86400000); return `${pad(d.getUTCDate())}-${pad(d.getUTCMonth() + 1)}-${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
const local = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(now);
const due = (days) => { const d = new Date(local + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10) + 'T23:00:00'; };
const nb = (days) => { const d = new Date(local + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + days); return `NB ${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/${String(d.getUTCFullYear()).slice(2)}`; };
const step = (station, machine, status = 'Waiting', productType = '') => ({ status, currentStation: station, machineName: machine, employeeName: null, productType });

const ORDERS = [
  { n: '268506', cust: 'Webfooters Postcard Club', works: 'WEBFOOTER SEPTEMBER NEWSLETTER', due: 0, notes: nb(0), total: '215.00', qty: 165, jobs: [['Booklets', 165, [step('Graphics', null, 'Waiting', 'Cover'), step('Graphics', null, 'Waiting', 'InternalPages')]]] },
  { n: '268505', cust: 'Subculture LLC', works: 'TRAVEL FLYERS', due: 2, notes: nb(3), total: '193.00', qty: 700, jobs: [['Flyers', 700, [step('Prepress', null)]]] },
  { n: '264698', cust: 'Riverside Funeral Home', works: 'Memorial Cards, Invoice Pads', due: 0, notes: nb(1), total: '175.00', qty: 87, jobs: [['Cards', 75, [step('Printing', 'Indigo 7900')]], ['Carbonless Forms', 12, [step('Printing', 'Konica', 'Waiting', 'InternalPages')]]] },
  { n: '264697', cust: 'Sandy Auto Body', works: 'Parking Sign - Reflective Mounted', due: -1, notes: null, total: '90.00', qty: 1, jobs: [['Rigid Signs', 1, [step('Printing', 'HP Latex')]]] },
  { n: '264695', cust: 'Menucha Retreat', works: ', MENUCHA MEANDER', due: 1, notes: nb(1), total: '1546.00', qty: 5101, jobs: [['Flyers', 5100, [step('Printing', 'Indigo 7900', 'In Progress')]]] },
  { n: '268502', cust: 'Pirates Crew', works: 'Pirates Crew T-Shirt', due: 3, notes: nb(3), total: '124.80', qty: 13, jobs: [['T-Shirt', 13, [step('Exposure (Stencil Creation)', 'Screen Printing')]]] },
  { n: '268501', cust: 'Mt Hood Transit', works: 'Transportation Slips', due: 4, notes: nb(5), total: '87.00', qty: 200, jobs: [['Carbonless Forms', 200, [step('Cutting', 'Guillotine')]]] },
  { n: '264694', cust: "Portland Women's Forum", works: 'GARDEN CLUB YEARBOOKS', due: 5, notes: 'NB ?', total: '138.00', qty: 45, jobs: [['Booklets', 30, [step('Packing', null)]]] },
  { n: '264528', cust: 'Summit Brewing', works: 'T-Shirt, Hat, Business Cards', due: null, notes: null, total: '361.00', qty: 503, proof: true, jobs: [['Business Cards', 500, [step('Graphics', null)]]] },
  { n: '264671', cust: 'Taqueria Sol', works: 'TO-GO MENUS', due: -1, notes: nb(0), total: '28.00', qty: 50, ready: 0, jobs: [['Menus', 50, []]] },
  // closed orders (only count toward shipped totals)
  { n: '264660', cust: 'Clackamas Rotary', works: 'EVENT POSTERS', due: -2, total: '412.00', qty: 40, ready: 0, closed: true, jobs: [] },
  { n: '264650', cust: 'Hood River Cider', works: 'LABELS', due: -6, total: '980.00', qty: 2000, ready: 5, closed: true, jobs: [] },
];
const orders = ORDERS.map((o, i) => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
  createdDate: created(o.closed ? 10 : i % 3),
  dueDate: o.due == null ? null : due(o.due),
  readyDate: o.ready != null ? utc(new Date(now - o.ready * 86400000)) : null,
  number: o.n, customerName: o.cust, contactName: o.cust, agentName: 'Ryan Zirk', customerSupportRepresentativeName: i === 2 ? 'Jen Smith' : null,
  notes: o.notes || null, statusTitleText: o.closed ? 'Order.Closed' : 'Order.Open', deliveryStatus: o.closed ? 3 : 1,
  totalPrice: o.total, totalPayment: o.total, worksNames: o.works, totalOrderQuantity: o.qty, isInProofingProcess: !!o.proof, internalNotes: null,
}));

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  let body;
  if (u.pathname === '/api/orders') {
    const page = Number(u.searchParams.get('page') || 0);
    body = { data: { data: page === 0 ? orders : [] } };
  } else {
    const m = /^\/api\/orders\/([^/]+)\/jobs$/.exec(u.pathname);
    const i = m ? orders.findIndex((o) => o.id === m[1]) : -1;
    if (i < 0) { res.writeHead(404); return res.end('not found'); }
    body = ORDERS[i].jobs.map(([productName, quantity, steps]) => ({ productName, quantity, jobStatuses: steps }));
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}).listen(PORT, () => console.log(`Mock Atlas API on :${PORT}`));
