# Gold Mobile Mechanic

Public, installable phone app for running vehicle jobs from clock-in through
invoice handoff.

- Public phone app: <https://thomasg42.github.io/gold-mobile-mechanic/>
- Public source: <https://github.com/thomasg42/gold-mobile-mechanic>
- Phone data: private browser storage on the device using the app

The GitHub Pages edition is public to open, but its jobs and receipt photos are
not public. Each browser gets a separate local ledger. Nothing entered into the
phone app is committed to GitHub or visible to another visitor.

## Operator workflow

1. Create a job with the customer, vehicle, labor rate, agreed work, and
   approved materials. The server assigns a durable
   `GMM-YYYYMMDD-XXXX` job ID.
2. Clock in. Start and end breaks as needed. Each transition closes the current
   time entry and opens the next one, so only work intervals are billable.
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

## Put it on a phone

- iPhone: open the public phone-app link in Safari, tap **Share**, then
  **Add to Home Screen**.
- Android: open the link in Chrome, open the browser menu, then choose
  **Install app** or **Add to Home screen**.

Use **Backup data** inside the app before clearing browser data, changing phones,
or removing the home-screen app. The backup includes jobs and receipt images;
**Restore** imports that file onto another device.

## Architecture

| Layer | Implementation |
|---|---|
| Public phone UI | Static PWA under `docs/`, hosted by GitHub Pages |
| Phone job state | `localStorage`, isolated to that browser and device |
| Phone receipt images | IndexedDB, isolated to that browser and device |
| Offline shell | Service worker caching the GitHub Pages assets |
| Server-backed reference | Next.js API routes plus D1/R2 implementation under `app/` and `db/` |
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
  index.html                      GitHub Pages phone shell
  styles.css                      Matching responsive charcoal/gold design
  app.js                          Device-local jobs, timers, receipts, invoices
  manifest.webmanifest            Home-screen installation metadata
  sw.js                           Offline application shell
tests/github-pages.test.mjs       Public phone-edition contract checks
```

## Data model

- `jobs`: customer, vehicle, labor rate, agreed work, suggestions, status,
  receipt-review flag, start/end timestamps.
- `time_entries`: `work` or `break`, with independent start/end timestamps.
- `materials`: agreed description, quantity, and unit cost.
- `receipts`: job ownership, R2 object key, filename, MIME type, vendor, amount,
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

Open `http://localhost:8000`. Local phone-edition data remains in that browser.

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
- The GitHub Pages phone contract covers the same workflow with device-local
  state, receipt backup/restore, install metadata, and an offline shell.
- Remote `main` is public and is the source for the GitHub Pages deployment.

## GitHub Pages publishing

GitHub Pages serves `main` from `/docs`. A normal push to `main` updates the
public phone app after GitHub finishes its Pages build.

## Reusing this for another service business

1. Copy the repository into a new isolated project.
2. Change business name, vocabulary, palette, invoice copy, and job fields.
3. Update both the GitHub Pages files in `docs/` and the server-backed reference
   when the workflow itself changes.
4. If the new business only needs one-device use, publish `/docs` through a new
   GitHub Pages repository.
5. If multiple devices need shared live records, provision a separate database
   and receipt bucket. Never reuse another business's storage.
6. Build and run the full lifecycle before deployment.
7. Add direct email only through an authorized backend with explicit sending
   controls.
