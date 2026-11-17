#!/usr/bin/env bash
#
# Ships estimates + customer approval + tax/supplies/deposit for Gold Mobile
# Mechanic. Run from YOUR OWN terminal: Claude Code has no wrangler or git
# push credentials.
#
# ORDER: preflight → tests → Worker → app. The Worker goes first because the
# old app never calls the new estimate routes, so nothing in the field can hit
# a missing one. No database migration: estimates live inside the job's JSON.
# Safe to re-run: every step either repeats harmlessly or skips.
set -euo pipefail
cd "$(dirname "$0")"

WORKER_URL="https://gold-mobile-mechanic-sync.forevergoldai.workers.dev"
PAGES_URL="https://thomasg42.github.io/gold-mobile-mechanic"

echo "==> 1/5  Preflight: GitHub must not be ahead of this copy"
git fetch --quiet origin main
if ! git merge-base --is-ancestor origin/main HEAD; then
  echo "     STOP: GitHub main has commits this copy doesn't. Nothing was deployed."
  echo "     Pull them in first (git pull --ff-only), then run this again."
  exit 1
fi
echo "     ok"

echo
echo "==> 2/5  Tests"
node --test tests/*.test.mjs

echo
echo "==> 3/5  Ship the Worker"
npx wrangler deploy --config wrangler.sync.jsonc
echo -n "     waiting for the new estimate route"
for attempt in $(seq 1 12); do
  if curl -s "$WORKER_URL/api/portal/estimates/nope" | grep -q "No such estimate"; then
    echo " — live"
    break
  fi
  if [ "$attempt" = 12 ]; then
    echo
    echo "     STOP: the Worker isn't answering the estimate route yet. The app was NOT pushed."
    echo "     Check: curl -s $WORKER_URL/api/portal/estimates/nope   (expect: No such estimate)"
    exit 1
  fi
  echo -n "."
  sleep 5
done
echo -n "     health: "
curl -s "$WORKER_URL/api/health"
echo

echo
echo "==> 4/5  Ship the app to GitHub Pages"
git add docs sync-worker/index.ts README.md deploy-estimates.sh \
  tests/estimate-approval.test.mjs tests/estimate-card.test.mjs \
  tests/portal-estimate.test.mjs tests/stripe-payment-link.test.mjs
git status --short
if git diff --cached --quiet; then
  echo "     nothing new to commit (already committed on an earlier run)"
else
  git commit -m "Estimates with customer approval, tax, shop supplies and deposits

Price a job line by line (labor, parts, fees), keep saved jobs, and send
the customer a private link. They approve or decline each line and sign
with their typed name. One tap puts the approved work on the invoice:
labor becomes the flat quoted amount (switchable back to the timer),
approved parts and fees bill as quoted lines, receipts still add on top,
and a later approval replaces the earlier scope instead of stacking it.

Sales tax and shop supplies are per job (both default 0). A deposit
received comes off the balance due and the Stripe card link. The share
button waits until the estimate has reached the cloud, so a customer is
never handed a dead link.

Every write to a job row is now a compare-and-swap, so a phone save and
a customer's signature landing at the same moment can't erase each other.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
fi
git push origin main

echo
echo "==> 5/5  Wait for Pages to serve the new version"
for attempt in $(seq 1 40); do
  if curl -s "$PAGES_URL/sw.js?nocache=$RANDOM" | grep -q "v35-estimates" \
     && curl -s "$PAGES_URL/portal.html?nocache=$RANDOM" | grep -q "estimateForm"; then
    echo "     LIVE: $PAGES_URL/"
    break
  fi
  if [ "$attempt" = 40 ]; then
    echo "     Pages has not served the new version yet. Re-check in a few minutes:"
    echo "     curl -s \"$PAGES_URL/sw.js\" | head -1   (expect v35-estimates)"
    exit 1
  fi
  sleep 15
done

echo
echo "On the phone: close and reopen the app once. Open a job, build a test"
echo "estimate, Send for approval, and open the link YOURSELF before any customer gets one."
