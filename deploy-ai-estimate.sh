#!/usr/bin/env bash
#
# Ships the AI estimate (book time & parts) for Gold Mobile Mechanic, and takes
# the general Ask Anya chat off the vehicle screen. Run from YOUR OWN terminal:
# Claude Code has no wrangler or git push credentials.
#
# Builds on the estimates release (8fff59d, deploy-estimates.sh). ORDER:
# preflight → tests → Worker → app. The Worker goes first because the old app
# never calls /api/assistant/estimate. No database migration. Safe to re-run.
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
# The estimate route is behind the PIN, so it can't be probed from here. The
# health probe proves the deploy came up with the Anthropic key it needs.
echo -n "     checking the Worker"
for attempt in $(seq 1 12); do
  if curl -s "$WORKER_URL/api/health" | grep -q '"assistant":true'; then
    echo " — up, assistant key present"
    break
  fi
  if [ "$attempt" = 12 ]; then
    echo
    echo "     STOP: the Worker health doesn't report assistant:true. The app was NOT pushed."
    echo "     Check: curl -s $WORKER_URL/api/health   (expect \"assistant\":true)"
    exit 1
  fi
  echo -n "."
  sleep 5
done

echo
echo "==> 4/5  Ship the app to GitHub Pages"
git add docs sync-worker/assistant.ts sync-worker/index.ts README.md deploy-ai-estimate.sh \
  tools/check-ai-hours.mjs tests/ai-estimate.test.mjs tests/anya-agent.test.mjs
git status --short
if git diff --cached --quiet; then
  echo "     nothing new to commit (already committed on an earlier run)"
else
  git commit -m "AI estimate: book time, parts and forgotten consumables on a new job

When a job is created with a make, model and agreed work, one Claude
Opus 5.5 call (no tools, never retried, refusal fallback on) returns per
job the AI-estimated flat-rate hours, the parts, and the consumables
people forget. The phone adds a labor line per job at the job's rate and
\$0 part lines to price, puts the names on the materials checklist, and
shows total hours and labor dollars. Every AI line is tagged \"AI estimate
- verify\"; nothing sends until every line is priced, and sending AI lines
asks for a check first. The model never prices anything.

The general Ask Anya chat is off the vehicle screen. tools/check-ai-hours
compares the AI's hours with the E30 answer key kept in the vault.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
fi
git push origin main

echo
echo "==> 5/5  Wait for Pages to serve the new version"
for attempt in $(seq 1 40); do
  if curl -s "$PAGES_URL/sw.js?nocache=$RANDOM" | grep -q "v36-ai-estimate" \
     && curl -s "$PAGES_URL/app.js?nocache=$RANDOM" | grep -q "aiEstimateButton"; then
    echo "     LIVE: $PAGES_URL/"
    break
  fi
  if [ "$attempt" = 40 ]; then
    echo "     Pages has not served the new version yet. Re-check in a few minutes:"
    echo "     curl -s \"$PAGES_URL/sw.js\" | head -1   (expect v36-ai-estimate)"
    exit 1
  fi
  sleep 15
done

echo
echo "On the phone: close and reopen the app once, then add a test job with real"
echo "work on it. The AI estimate fills in by itself; check the hours, price the parts."
