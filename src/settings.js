// Gauge targets, editable from the /settings page (no code changes needed).
// Saved to DATA_DIR/settings.json, so they survive restarts as long as a Railway volume is attached.
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

const FILE = path.join(cfg.dataDir, 'settings.json');
const num = (v, d) => (v === undefined || v === '' || isNaN(Number(v)) ? d : Number(v));

// Starting values (from the old dashboard). Railway variables can override these defaults.
const DEFAULTS = {
  receivedToday: num(process.env.TARGET_RECEIVED_TODAY, 15833.36),
  shippedToday: num(process.env.TARGET_SHIPPED_TODAY, 15833.36),
  shippedMonth: num(process.env.TARGET_SHIPPED_MONTH, 348334),
  shippedYear: num(process.env.TARGET_SHIPPED_YEAR, 3580367),
  // Press hours available per workday, for the press-time chart
  // 8-hour day less 90 minutes for breaks and maintenance; Konica isn't counted toward capacity
  pressIndigoHours: num(process.env.PRESS_INDIGO_HOURS, 6.5),
  pressRicohHours: num(process.env.PRESS_RICOH_HOURS, 6.5),
};

let targets = { ...DEFAULTS };
try {
  const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  targets = { ...targets, ...saved.targets };
} catch { /* first run: use defaults */ }

function getTargets() {
  return { ...targets };
}

function setTargets(input) {
  const next = { ...targets };
  for (const k of Object.keys(DEFAULTS)) {
    if (input[k] === undefined || input[k] === '') continue;
    const v = Number(String(input[k]).replace(/[$,\s]/g, ''));
    if (!isFinite(v) || v < 0) throw new Error(`"${k}" must be a positive number`);
    next[k] = Math.round(v * 100) / 100;
  }
  targets = next;
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify({ targets, updatedAt: new Date().toISOString() }, null, 2));
  return getTargets();
}

module.exports = { getTargets, setTargets };
