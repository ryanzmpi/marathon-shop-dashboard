// All settings come from environment variables (set them in Railway → Variables).
const path = require('path');

const num = (v, d) => (v === undefined || v === '' || isNaN(Number(v)) ? d : Number(v));

const listenerUrl = process.env.LISTENER_URL || 'https://marathonprinting.pagepath.com/planweb/Listener.aspx';

module.exports = {
  port: num(process.env.PORT, 3000),

  // Printer's Plan Web2Plan listener (read-only GET requests only).
  listenerUrl,
  // The listener refuses requests without a Referer header.
  referer: process.env.LISTENER_REFERER || new URL(listenerUrl).origin + '/planweb/',

  // Dashboard login. Leave unset for no login screen (open to anyone with the URL).
  password: process.env.DASHBOARD_PASSWORD || '',
  // Optional: a secret for display screens, used as ?key=… in the URL instead of logging in.
  displayKey: process.env.DISPLAY_KEY || '',
  sessionSecret: process.env.SESSION_SECRET || process.env.DASHBOARD_PASSWORD || '',
  sessionDays: num(process.env.SESSION_DAYS, 365),

  timeZone: process.env.TZ_NAME || 'America/Los_Angeles',

  // Where scan results are cached between restarts (mount a Railway volume here).
  dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),

  // Scanning behaviour.
  refreshSeconds: num(process.env.REFRESH_SECONDS, 120), // how often open jobs are re-checked
  maxConcurrency: num(process.env.MAX_CONCURRENCY, 4), // simultaneous requests to the listener
  requestTimeoutMs: num(process.env.REQUEST_TIMEOUT_MS, 20000),
  startJobNo: num(process.env.START_JOBNO, 0), // optional: a recent job number to start from
  backfillCount: num(process.env.BACKFILL_COUNT, 5000), // how many job numbers back to look for open jobs
  historySeedCount: num(process.env.HISTORY_SEED_COUNT, 1500), // also record invoiced jobs this far back
  gapLimit: num(process.env.GAP_LIMIT, 25), // consecutive unused numbers before we assume we've hit the newest job
  invoicedKeepDays: num(process.env.INVOICED_KEEP_DAYS, 120),
};
