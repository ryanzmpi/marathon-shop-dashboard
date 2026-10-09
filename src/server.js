const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');
const scanner = require('./scanner');
const settings = require('./settings');

const PUBLIC = path.join(__dirname, '..', 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function loadLabels() {
  let labels = {};
  try { labels = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'labels.json'), 'utf8')); } catch {}
  if (process.env.LABELS_JSON) {
    try { labels = { ...labels, ...JSON.parse(process.env.LABELS_JSON) }; } catch (e) { console.error('LABELS_JSON is not valid JSON:', e.message); }
  }
  delete labels._help;
  return labels;
}
const labels = loadLabels();

// ---------- auth: a signed cookie after entering the dashboard password ----------
const COOKIE = 'msd_session';
const sign = (v) => crypto.createHmac('sha256', cfg.sessionSecret).update(v).digest('base64url');
function makeToken() {
  const exp = Date.now() + cfg.sessionDays * 86400000;
  return `${exp}.${sign(String(exp))}`;
}
function validToken(tok) {
  if (!tok || !cfg.sessionSecret) return false;
  const [exp, sig] = tok.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const good = sign(exp);
  return sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
}
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=').map(decodeURIComponent)).filter((p) => p[0]));
}
const passwordOk = (p) => {
  const a = crypto.createHash('sha256').update(String(p)).digest();
  const b = crypto.createHash('sha256').update(cfg.password).digest();
  return cfg.password && crypto.timingSafeEqual(a, b);
};

function send(res, code, body, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(code, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow',
    ...extra,
  });
  res.end(body);
}
function sendFile(res, file) {
  const full = path.join(PUBLIC, file);
  if (!full.startsWith(PUBLIC)) return send(res, 404, 'Not found');
  fs.readFile(full, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    send(res, 200, data, TYPES[path.extname(full)] || 'application/octet-stream');
  });
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e4) req.destroy(); });
    req.on('end', () => resolve(b));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (p === '/health') return send(res, 200, 'ok');
  // No DASHBOARD_PASSWORD set → the dashboard is open to anyone with the URL (no login screen).
  const open = !cfg.password;
  // DISPLAY_KEY lets signage players skip the login: https://<url>/tv?key=<DISPLAY_KEY>
  const keyOk = cfg.displayKey && url.searchParams.get('key') === cfg.displayKey;

  if (p === '/login' && req.method === 'POST') {
    const body = new URLSearchParams(await readBody(req));
    const next = (body.get('next') || '/').startsWith('/') ? body.get('next') || '/' : '/';
    if (passwordOk(body.get('password') || '')) {
      const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
      return send(res, 303, '', 'text/plain', {
        Location: next,
        'Set-Cookie': `${COOKIE}=${makeToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${cfg.sessionDays * 86400}${secure}`,
      });
    }
    await new Promise((r) => setTimeout(r, 1200)); // slow down guessing
    return send(res, 303, '', 'text/plain', { Location: `/login?bad=1&next=${encodeURIComponent(next)}` });
  }
  if (p === '/login') return sendFile(res, 'login.html');
  if (p === '/logout' && open) return send(res, 303, '', 'text/plain', { Location: '/' });
  if (p === '/logout') return send(res, 303, '', 'text/plain', { Location: '/login', 'Set-Cookie': `${COOKIE}=; Path=/; Max-Age=0` });
  if (p === '/login.css') return sendFile(res, 'app.css');
  if (p === '/favicon.svg') return sendFile(res, 'favicon.svg');

  if (!open && !keyOk && !validToken(cookies(req)[COOKIE])) {
    if (p.startsWith('/api/')) return send(res, 401, '{"error":"login required"}', 'application/json');
    return send(res, 303, '', 'text/plain', { Location: `/login?next=${encodeURIComponent(p + url.search)}` });
  }

  if (p === '/api/data') {
    const snap = scanner.snapshot();
    return send(res, 200, JSON.stringify({ generatedAt: new Date().toISOString(), today: scanner.todayLocal(), timeZone: cfg.timeZone, labels, targets: settings.getTargets(), ...snap }), 'application/json');
  }
  // Gauge targets. Saving requires SETTINGS_PIN when that variable is set in Railway.
  if (p === '/api/settings' && req.method === 'GET') {
    return send(res, 200, JSON.stringify({ targets: settings.getTargets(), pinRequired: !!cfg.settingsPin }), 'application/json');
  }
  if (p === '/api/settings' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, '{"error":"bad request"}', 'application/json'); }
    if (cfg.settingsPin && String(body.pin || '') !== cfg.settingsPin) {
      await new Promise((r) => setTimeout(r, 1000));
      return send(res, 403, '{"error":"Wrong PIN"}', 'application/json');
    }
    try {
      return send(res, 200, JSON.stringify({ targets: settings.setTargets(body.targets || {}) }), 'application/json');
    } catch (e) {
      return send(res, 400, JSON.stringify({ error: e.message }), 'application/json');
    }
  }
  if (p === '/settings' || p === '/settings.html') return sendFile(res, 'settings.html');
  if (p === '/' || p === '/index.html') return sendFile(res, 'index.html');
  if (p === '/tv' || p === '/tv.html') return sendFile(res, 'tv.html');
  if (p === '/office-tv' || p === '/office-tv.html') return sendFile(res, 'office-tv.html');
  if (/^\/[a-z0-9_-]+\.(css|js|svg|ico)$/i.test(p)) return sendFile(res, p.slice(1));
  return send(res, 404, 'Not found');
});

server.listen(cfg.port, () => {
  console.log(`Shop dashboard listening on :${cfg.port}`);
  if (!cfg.password) console.warn('DASHBOARD_PASSWORD is not set — the dashboard is open to anyone with the URL.');
  scanner.start();
});
