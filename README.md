# Gold Mobile Mechanic

Private, mobile-first field app for running vehicle jobs from clock-in through
invoice handoff.

## Workflow

1. Create a job with the customer, vehicle, labor rate, agreed work, and
   approved materials.
2. Clock in, start and end breaks, and clock out at the bottom of the job.
3. Take receipt photos from the phone camera. Images are stored in the receipt
   folder for that job.
4. Save the mechanic's suggestions. They are printed on the invoice.
5. Review the receipt folder, create the invoice, then download, share, or open
   a prepared customer email.

## Data

- D1 stores jobs, time entries, materials, receipt metadata, and invoices.
- R2 stores private receipt images under each job ID.
- The production deployment is intended to stay owner-only.

## Local development

```bash
npm install
npm run dev
```

## Validation

```bash
npm test
npx tsc --noEmit
npm run lint
```

The automated checks cover the production build and required workflow surface.
The full API lifecycle has also been verified locally: create job, clock in,
break start/end, receipt upload/retrieval, suggestions, clock out, receipt
review, and invoice calculation.
