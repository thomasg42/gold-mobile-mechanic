-- One row per Stripe payment link the shop has sent. Tapping "Send Stripe
-- payment link" twice on the same bill must hand back the SAME link rather
-- than mint a second one the customer could also pay, so the Worker looks
-- here before it ever calls Stripe. A reopened invoice with a new total gets a
-- new row, and the old link is switched off at Stripe.
CREATE TABLE IF NOT EXISTS stripe_payment_links (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  invoice_number TEXT NOT NULL,
  invoice_cents INTEGER NOT NULL,
  fee_cents INTEGER NOT NULL,
  total_cents INTEGER NOT NULL,
  url TEXT NOT NULL,
  stripe_customer_id TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS stripe_payment_links_job_idx
  ON stripe_payment_links(job_id, active)
;
