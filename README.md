# Marathon Printing · Shop Dashboard

A web dashboard showing open jobs from Printer's Plan. It reads job data from the Web2Plan listener (`Listener.aspx`) at `marathonprinting.pagepath.com`.

- **Office view** (`/`): late, due today and upcoming counts; a workload chart; jobs by stage; shipped totals; and a searchable, sortable job table. Click any row to see its line items and work-order note.
- **Goal gauges** (office view): Received Today, Shipped Today, Shipped This Month and Shipped This Year, each against a target. Change the targets at **`/settings`** (the "Edit targets" link): type the numbers and click Save. No code changes are needed.
- **Office TV** (`/office-tv`): built for a normal horizontal TV. It has the same summary tiles and Late / Due today / next-workday lists as the shop TV, plus the four goal gauges.
- **Reprints:** any job with "reprint" in its title is flagged red, with a Reprint label, on both views.
- **TV view** (`/tv`): a full-screen display for the shop floor (works on vertical and horizontal screens) showing Late, Due today and Due next workday. It refreshes every minute and pages through long lists on its own.

It only makes **read-only GET requests** to `Listener.aspx`. It never calls `XmlListener.aspx`, which creates orders.

## How it works

The listener has no "list all open jobs" command, so the service walks job numbers:

1. **First run (backfill):** checks the last `BACKFILL_COUNT` job numbers (default 5,000) for jobs that are still open. It also records recently invoiced jobs so the shipped totals have history. At about 0.8 s per request with 4 in parallel, this takes roughly 15–25 minutes. The dashboard works during the backfill and shows a progress banner.
2. **Every `REFRESH_SECONDS` (default 60):** re-checks every known open job, then probes upward from the newest job number to pick up new ones.
3. **Shipped jobs drop off right away:** as soon as a ship date is entered on a job in Printer's Plan, it leaves the open list and counts toward the shipped totals, even before it's invoiced.
4. When a job stops showing as open, the service looks it up in History and counts it as shipped/invoiced. It uses the job's subtotal and `DateShipped`.

Results are cached in `DATA_DIR/state.json`, so a restart doesn't trigger a full re-scan, as long as a volume is attached. If the listener can't be reached, existing jobs are kept and the status pill turns red.

Job types the listener understands (`todo=GetJob&type=…&jobno=…`): `Order` (open jobs), `History` (invoiced), `Quote`, `WebOrder`, `Template`.

## Deploy on Railway

1. In Railway, choose **New Project → Deploy from GitHub repo** and pick `marathon-shop-dashboard`.
2. Open the service, go to **Variables** and add:

   | Variable | Value |
   |---|---|
   | `START_JOBNO` | a recent job number, e.g. `267200` |
   | `DASHBOARD_PASSWORD` | *optional* — leave it out for no login screen at all |
   | `DISPLAY_KEY` | *optional* — with a password set, lets displays skip the login via `/tv?key=<DISPLAY_KEY>` |
   | `SETTINGS_PIN` | *optional, recommended*: a PIN needed to save gauge targets on `/settings` |
   | `SESSION_SECRET` | *optional* — any long random string (keeps logins valid across restarts) |

3. Under **Settings → Networking**, click **Generate Domain** to get a URL.
4. Optional, but it avoids a re-scan after every deploy: right-click the service → **Attach Volume**, set the mount path to `/data`, then add the variable `DATA_DIR=/data`.
5. Open the URL. On shop displays, point the player at `<your-url>/tv` (or `<your-url>/tv?key=…` if you use a password + `DISPLAY_KEY`).

Railway detects Node and runs `npm start` automatically. The health check is at `/health`.

### Optional settings

| Variable | Default | What it does |
|---|---|---|
| `LISTENER_URL` | `https://marathonprinting.pagepath.com/planweb/Listener.aspx` | Listener address |
| `REFRESH_SECONDS` | `60` | How often open jobs are re-checked |
| `MAX_CONCURRENCY` | `4` | Requests in flight to Printer's Plan at once (keep this low) |
| `BACKFILL_COUNT` | `5000` | How many job numbers back to look for older open jobs |
| `HISTORY_SEED_COUNT` | `1500` | How far back the first run records invoiced jobs |
| `INVOICED_KEEP_DAYS` | `120` | How long shipped jobs are kept for totals |
| `TZ_NAME` | `America/Los_Angeles` | Time zone used to decide "today" |
| `LABELS_JSON` | — | Names for status codes and people (see below) |

## Gauge targets

Targets are saved to `DATA_DIR/settings.json`, so they persist across redeploys when a volume is attached. The first time it starts, the dashboard uses the old dashboard's targets: $15,833.36 per day for received and shipped, $348,334 per month and $3,580,367 per year. You can also set starting values with `TARGET_RECEIVED_TODAY`, `TARGET_SHIPPED_TODAY`, `TARGET_SHIPPED_MONTH` and `TARGET_SHIPPED_YEAR`.

- **Shipped** means a job has a ship date (invoiced or not), valued at its full total.
- **Received** means jobs entered today. Jobs that aren't priced yet count as $0 until they are.
- For **Shipped This Year**, the server walks back through History once after deploying, to pick up everything shipped since January 1. That takes roughly 20–30 minutes. The gauge says "Still loading" until it's done.
- Gauge colors are relative to the target: red below 50%, orange 50–75%, yellow 75–90%, green 90% and up.

## Naming the status codes

Until names are filled in, everything shows as a number ("Status 2", "#102"). Add the names in `config/labels.json`, or paste the same JSON into the `LABELS_JSON` variable in Railway, which doesn't need a commit:

```json
{
  "jobStatus":  { "0": "Prepress", "1": "Proof out", "2": "Approved", "5": "On press" },
  "itemStatus": { "0": "Not started", "4": "Done" },
  "csr":        { "101": "Jane", "102": "Mike" },
  "salesRep":   { "200": "House", "203": "Ryan" },
  "employee":   { "3": "Press operator" },
  "service":    { "474": "Design", "475": "Proof" },
  "stageOrder": ["Prepress", "Proof out", "Approved", "On press"],
  "hiddenJobStatuses": []
}
```

- `stageOrder` controls the order of stages on both views.
- Any job status listed in `hiddenJobStatuses` (for example, "On hold") is left off the dashboard.
- A job's **stage** is the lowest status among its product lines (service/operation lines are ignored). Name those codes under `itemStatus`. `jobStatus` is no longer used.

## Run locally

```bash
node test/mock-listener.js   # fake listener with made-up jobs on :4100
LISTENER_URL=http://localhost:4100/planweb/Listener.aspx DASHBOARD_PASSWORD=test START_JOBNO=267100 npm start
# open http://localhost:3000 (password: test)
```

There are no dependencies. Requires Node 20 or newer.

## Security note

`Listener.aspx` has no login of its own. Anyone with the URL can read job details, including customer contact information. Ask Print Reach to restrict it, by IP allowlist or an access key. If they allowlist by IP, Railway can provide a static outbound IP on its paid plan.
