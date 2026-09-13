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

1. **Add invoice** opens the sheet. Every car already on the ledger is listed
   at the top — tap one and the customer and vehicle fill themselves in. Fill
   the rest by thumb, or tap **Talk to Anya** and just say it, all in one go if
   you want: she takes every field out of what you said, asks only for what is
   genuinely still missing, and writes each answer into the real form input as
   you go. Anything you mention that is not a field — a worn part, something to
   check next visit — goes to the notes that print on the invoice. She reads the
   sheet back and saves nothing until you say yes, and starts the clock on the
   new job if you told her to. The server assigns a durable
   `GMM-YYYYMMDD-XXXX` job ID.
2. Clock in. Pause/resume as needed. Every action writes both the current
   interval and an append-only clock-history event. A unique mutation ID makes
   retries safe if mobile service drops after the server receives an action.
3. Take receipt photos from the phone camera. Images are stored under
   `jobs/{jobId}/receipts/` and their vendor, amount, filename, MIME type, and
   timestamp are stored with the job.
4. Save the mechanic's suggestions. They print directly on the invoice.
4a. Correct anything, any time. Every card on a work order carries an Edit
   button — customer name, caller's phone, email, vehicle, plate, agreed work,
   materials, hourly rate, and suggestions are all editable after creation and
   sync back to the cloud ledger on save.
5. Clock out at the bottom of the job. This freezes billable work time.
6. Review the receipt folder. Invoice creation stays locked until clock-out and
   this explicit review are both complete.
7. Create the invoice. Labor is calculated from work seconds × hourly rate;
   agreed materials are added separately. Download or share the invoice with
   embedded receipt images, or open the prepared customer email.
8. Send the customer their invoice link. The filed-invoice card shows a
   permanent portal link — `portal.html#customer/<id>` — that opens straight to
   that one customer's filed invoices. **Copy link** puts it on the clipboard,
   and the prepared email already carries it. The `<id>` is a hash of the
   customer's name and phone (matching the sync worker), so correcting either
   one afterward mints a new link.
9. Unsubmit an invoice if something has to change. **Unsubmit invoice** (on the
   filed-invoice card and at the bottom of the work order) reopens the job
   clocked out, withdraws the filed invoice so it leaves the customer portal,
   and unlocks every field. Billable time, intervals, and the clock ledger are
   untouched. Fix what's needed, clock back in if you owe more time, then hit
   Finish Project to file it again.

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
  assistant.js                    Anya: the sheet conversation, and the chat that can act on a job
  voice.js                        The spoken turn — mic, silence detection, type-instead
  voice-config.js                 Wording for the scripted receipt and closeout interviews
  icon-192.png / icon-512.png      Home-screen and install icons
  manifest.webmanifest            Home-screen installation metadata
  sw.js                           Offline application shell
tests/github-pages.test.mjs       Public phone-edition contract checks
sync-worker/
  index.ts                        Authenticated jobs and receipts API
  assistant.ts                    Anya's Anthropic proxy — holds the API key, runs no job changes
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

## Anya

Two surfaces, one model, one endpoint group on the Worker. **The phone never
holds an API key** — every turn goes to `/api/assistant/*`, which is locked to
the GitHub Pages origin and rate-limited per caller, exactly like the voice
routes.

| Surface | Where | What it does |
|---|---|---|
| **Talk to Anya** | Top of the Add invoice sheet | Fills the sheet by conversation (`/api/assistant/invoice`). Returns structured JSON, never prose — a misheard sentence cannot land in a customer record as if it were a value. |
| **Ask Anya** | Board, and inside a job | A real chat (`/api/assistant/chat`). Repair help with the video first, and she can act on the open job. |

Both stay hidden until `GET /api/health` reports `assistant: true`, so a button
that would always fail is never shown.

### What she can actually do, and who runs it

Web search runs on Anthropic's servers. Every job-changing tool runs **on the
phone** — the Worker returns the call unexecuted, the app applies it through the
same function the button calls, and the outcome goes back as a tool result. The
Worker never touches a job: the phone is what holds the offline queue, the sync
state and the timer, and a change made around it is a change the app does not
know it made.

| Tool | What it does | Refuses when |
|---|---|---|
| `clock_in` | Starts billable time | Already on the clock, or no job open |
| `clock_out` | Stops billable time | Not on the clock |
| `add_note` | Appends to the notes that print on the invoice | Empty note |
| `set_agreed_work` | Replaces what the invoice bills against | Empty description |

A refusal goes back as `is_error`, so she reports what actually happened. "You're
on the clock" said over a clock that never started is unbilled labour.

Nothing is possible when no job is open, and everything is refused on a job whose
invoice is already filed — she says to unsubmit it first.

### Phone first

This is used one-handed, outdoors, on a phone, with the truck still in front of
him. The layout is built at phone width and only widens past 620px. Three rules
in `styles.css` are load-bearing and are pinned by a test, because all three fail
silently: 16px minimum on any input (below that iOS zooms the page on focus and
never zooms back), `dvh` rather than `vh` (or the keyboard buries the composer),
and `env(safe-area-inset-bottom)` on the composer (or it sits under the home
indicator). Tap targets are 48px and up.

**Two rules in her prompts are not decoration, and must not be softened:**

- **Pricing is never invented.** The agent asks for the labor rate and uses
  exactly what it is told. It never suggests one.
- **Specs are never guessed.** A torque figure, capacity, clearance or
  tightening sequence must come from a source the agent actually searched that
  turn, or it has to say it could not confirm it. A wrong torque number on a
  steering or suspension fastener is a safety failure, not a bad answer.

The Worker also overrules the model on completeness: `ready` is refused while
any of customer name, make, model, agreed work or labor rate is blank, and the
form's own validation still runs on submit. The model's opinion is an opinion.

### Turning it on

```bash
wrangler secret put ANTHROPIC_API_KEY --config wrangler.sync.jsonc
wrangler deploy --config wrangler.sync.jsonc
curl -s https://gold-mobile-mechanic-sync.forevergoldai.workers.dev/api/health
# -> {"ok":true,...,"assistant":true}
```

Costs run on the Anthropic API: Claude Opus 5 tokens on every turn, plus a
billable web search per shop-mode lookup. The per-caller cap
(`ASSISTANT_RATE_LIMIT`) is a runaway guard, not a budget — set a spend limit
in the Anthropic console if that matters.

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
