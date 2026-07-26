# Gold Mobile Mechanic

Private, mobile-first field app for running vehicle jobs from clock-in through
invoice handoff.

- Private app: <https://gold-mobile-mechanic.thomas-g-gutierrez42.chatgpt.site>
- Private source: <https://github.com/thomasg42/gold-mobile-mechanic>
- Production data: Cloudflare D1 + R2, provisioned by Sites

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

## Architecture

| Layer | Implementation |
|---|---|
| UI | Next.js App Router client UI in `app/MechanicApp.tsx` |
| Styling | Product-specific responsive CSS in `app/globals.css` |
| API | App Router handlers under `app/api/` |
| Structured state | D1 binding `DB` |
| Receipt images | R2 binding `RECEIPTS` |
| Schema | `db/schema.ts` + generated Drizzle migration |
| Runtime initialization | Idempotent prepared statements in `db/store.ts` |
| Hosting | Private Sites deployment, owner-only access |
| Source control | Private GitHub repository, `main` |

## Source map

```text
app/
  MechanicApp.tsx                 Complete job-board and job-detail UI
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

```bash
npm install
npm run dev
```

The local Cloudflare runtime creates isolated D1/R2 state under ignored
`.wrangler/` files. Local verification data never ships to production.

## Validation

```bash
npm test
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
- Remote `main` is private and matches the committed source.

## Reusing this for another service business

1. Copy the repository into a new isolated project.
2. Change business name, vocabulary, palette, invoice copy, and job fields.
3. Remove the existing `project_id` from `.openai/hosting.json`. Never reuse this
   deployment's D1 database or R2 bucket for another business.
4. Keep logical bindings as `DB` and `RECEIPTS`, or update the runtime and routes
   together.
5. Build and run the full lifecycle before deployment.
6. Create a new private repository and a new owner-only Sites project.
7. Add direct email only through an authorized backend with explicit sending
   controls.
