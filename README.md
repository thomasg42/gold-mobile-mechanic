# Gold Mobile Mechanic

Installable GitHub Pages app for running vehicle jobs from clock-in through
invoice handoff.

- Canonical live app: <https://thomasg42.github.io/gold-mobile-mechanic/>
- Public source: <https://github.com/thomasg42/gold-mobile-mechanic>
- Job/time data: private Cloudflare D1 ledger behind an authenticated sync API
- Receipt images: private D1 receipt records, cached in IndexedDB on each phone

GitHub Pages is the only user-facing app URL. Its private sync key is saved only
on connected devices and sent to the hidden API as an authorization header; it
is never committed to GitHub. D1 is the source of truth for jobs, timer
intervals, append-only clock events, and receipt files. Each phone keeps a
last-known recovery copy and queues changes while offline.

## Operator workflow

1. Create a job in the GitHub app with the customer, vehicle, labor rate,
   agreed work, and approved materials. The server assigns a durable
   `GMM-YYYYMMDD-XXXX` job ID.
2. Clock in. Pause/resume as needed. Every action writes both the current
   interval and an append-only clock-history event. A unique mutation ID makes
   retries safe if mobile service drops after the server receives an action.
3. Take receipt photos from the phone camera. Images are stored under
   `jobs/{jobId}/receipts/` and their vendor, amount, filename, MIME type, and
   timestamp are stored with the job.
4. Save the mechanic's suggestions. They print directly on the invoice.
5. Clock out at the bottom of the job. This freezes billable work time.
6. Review the receipt folder. Invoice creation stays locked until clock-out and
   this explicit review are both complete.
7. Create the invoice. Labor is calculated from work seconds × hourly rate;
   agreed materials are added separately. Download or share the invoice with
   embedded receipt images, or open the prepared customer email.

The app does not claim an email was sent before the phone's mail/share sheet
confirms it. Fully automatic Gmail sending is a separate connected-backend
feature and must retain the sending authorization gate.

## Put the GitHub app on a phone

- iPhone: open the paired GitHub Pages link in Safari, tap **Share**, then
  **Add to Home Screen**.
- Android: open the paired GitHub Pages link in Chrome, open the browser
  menu, then choose
  **Install app** or **Add to Home screen**.

The pairing fragment is stripped immediately after the key is stored locally.
The cloud ledger then returns after reloads, app restarts, deployments, and
device changes. **Backup data** remains available as a second recovery path.

## Architecture

| Layer | Implementation |
|---|---|
| Canonical phone UI | Static PWA under `docs/`, hosted by GitHub Pages |
| Private sync API | Cloudflare Worker; implementation endpoint, never the app URL |
| Authoritative job state | Private D1 records, one JSON ledger per job |
| Authoritative receipt images | Private D1 receipt records |
| Mobile recovery | LocalStorage/IndexedDB cache plus pending job and receipt queues |
| Clock history | Time intervals plus append-only `eventHistory` records |
| Offline shell | Service worker; queued changes replay when online |
| Source control | Public GitHub repository, `main` |

## Source map

```text
app/
  MechanicApp.tsx                 Server-backed job-board and job-detail UI
  globals.css                     Charcoal, paper, and antique-gold design system
  api/jobs/route.ts               List and create jobs
  api/jobs/[jobId]/route.ts       Read/update suggestions, email, receipt review
  api/jobs/[jobId]/timer/route.ts Clock-in, break start/end, clock-out state machine
  api/jobs/[jobId]/receipts/      Camera receipt upload to R2
  api/jobs/[jobId]/invoice/       Invoice validation and calculation
  api/receipts/[receiptId]/       Private receipt retrieval
db/
  schema.ts                       Jobs, entries, materials, receipts, invoices
  store.ts                        Bindings and idempotent runtime schema
  jobs.ts                         Job hydration and billable-time calculation
drizzle/                          Deployable D1 migration
public/og.png                     Matching charcoal/gold social card
tests/rendered-html.test.mjs      Product-shell and workflow contract checks
docs/
  index.html                      Canonical GitHub Pages phone shell
  styles.css                      Matching responsive charcoal/gold design
  app.js                          Cloud sync, offline recovery, timers, receipts, invoices
  icon-192.png / icon-512.png      Home-screen and install icons
  manifest.webmanifest            Home-screen installation metadata
  sw.js                           Offline application shell
tests/github-pages.test.mjs       Public phone-edition contract checks
sync-worker/
  index.ts                        Authenticated jobs and receipts API
  migrations/                     Private durable D1 schema
wrangler.sync.jsonc               Backend deployment configuration
```

## Data model

- `jobs`: customer, vehicle, labor rate, agreed work, suggestions, status,
  receipt-review flag, start/end timestamps.
- `time_entries`: `work` or `break`, with independent start/end timestamps.
- `eventHistory`: append-only clock-in, pause, resume, and clock-out records
  stored with each synchronized job.
- `materials`: agreed description, quantity, and unit cost.
- `receipts`: job ownership, image bytes, MIME type, filename, vendor, amount,
  and timestamp.
- `invoices`: one invoice per job, calculated labor/material/total cents,
  recipient email, status, and timestamp.

Money is stored as integer cents. Timestamps are stored as ISO UTC values.

## Timer state machine

```text
draft
  -> clock_in -> in_progress
  -> break_start -> on_break
  -> break_end -> in_progress
  -> clock_out -> completed
  -> receipt review + create invoice -> invoiced
```

Invalid transitions return HTTP `409`. Clock-out is unavailable during a break.

## Local development

Requirements: Node 22.13 or newer.

Server-backed reference:

```bash
npm install
npm run dev
```

GitHub Pages phone edition:

```bash
python3 -m http.server 8000 --directory docs
```

Open `http://localhost:8000`. Localhost is allowed by the sync API for testing.

## Validation

```bash
npm test
npm run test:pages
npx tsc --noEmit
npm run lint
npm audit --omit=dev
```

Verified on July 26, 2026:

- Production build passes.
- Two Node tests pass.
- Strict TypeScript passes.
- ESLint passes.
- Production dependency audit reports zero known vulnerabilities.
- Full real API lifecycle passes:
  create → clock in → break start/end → receipt upload/retrieval → suggestions →
  clock out → receipt review → invoice.
- The GitHub Pages contract covers authenticated cloud persistence, device-local
  recovery, receipt backup/restore, clock history, install metadata, and an
  offline shell.
- The pause/restart test creates a job, clocks in, pauses, fully restarts the
  runtime, verifies the open break and history, resumes, clocks out, restarts
  again, and verifies all four clock events and all three intervals.

## Publishing

GitHub Pages serves the only live app from `main:/docs`. The Worker is a hidden,
authenticated persistence API and must not be presented as a user-facing URL.
A normal push to `main` publishes the app after GitHub finishes its Pages build.

## Reusing this for another service business

1. Copy the repository into a new isolated project.
2. Change business name, vocabulary, palette, invoice copy, and job fields.
3. Update both the GitHub Pages files in `docs/` and the server-backed reference
   when the workflow itself changes.
4. Publish `/docs` through a new GitHub Pages repository.
5. Provision a separate Worker, database, and sync secret. Never reuse another
   business's storage or credentials.
6. Build and run the full lifecycle before deployment.
7. Add direct email only through an authorized backend with explicit sending
   controls.
