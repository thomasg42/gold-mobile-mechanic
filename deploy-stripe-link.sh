#!/usr/bin/env bash
#
# Turns on "Send Stripe payment link" for Gold Mobile Mechanic invoices.
#
# Run this from YOUR OWN terminal in this directory. Claude Code cannot: it has
# no wrangler credentials and no git push credentials in its sandbox.
#
# ORDER: database table → Stripe key → Worker → app. The Worker goes before the
# app because the old app never calls the new route, so nothing in the field
# can hit a route that is not there yet.
#
# The key you paste is a RESTRICTED key from Stripe → Developers → API keys →
# "Create restricted key", with WRITE on Customers, Products, Prices and
# Payment Links and nothing else. It is never written to this repo.
set -euo pipefail
cd "$(dirname "$0")"

WORKER_URL="https://gold-mobile-mechanic-sync.forevergoldai.workers.dev"

echo "==> 1/5  Tests"
node --test tests/*.test.mjs

echo
echo "==> 2/5  Create the payment-link table in the live database"
npx wrangler d1 migrations apply gold-mobile-mechanic-sync --remote --config wrangler.sync.jsonc

echo
echo "==> 3/5  Stripe key (paste the rk_live_… restricted key when asked)"
npx wrangler secret put STRIPE_SECRET_KEY --config wrangler.sync.jsonc

echo
echo "==> 4/5  Ship the Worker"
npx wrangler deploy --config wrangler.sync.jsonc
echo -n "     health: "
curl -s "$WORKER_URL/api/health"
echo
echo "     (cardPayments must say true)"

echo
echo "==> 5/5  Ship the app to GitHub Pages"
git add -A
git commit -m "Send a Stripe card payment link from any filed invoice

After Share the app offers a Stripe link; every invoice also has an
'or send Stripe link' button. The Worker creates the Stripe customer, the
invoice price, a card-processing-fee line grossed up so the shop keeps the
whole bill (capped at 3%), and a single-use card-only payment link, then
the phone drops a ready-to-send text into the share sheet. Same bill twice
returns the same link; a refiled bill switches the old link off.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin main

echo
echo "Done. On the phone: close and reopen the app once so it picks up the new"
echo "version, open a filed invoice, tap 'or send Stripe link', and send the"
echo "first one to YOURSELF before a customer gets one."
