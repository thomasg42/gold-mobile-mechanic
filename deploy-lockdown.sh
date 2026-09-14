#!/usr/bin/env bash
#
# Closes the open sync API, in the order that keeps the phones working.
#
# Run this from YOUR OWN terminal in this directory. Claude Code cannot: it has
# no wrangler credentials and no git push credentials in its sandbox.
#
# THE ORDER IS THE WHOLE POINT.
#   1. The PIN lands first. The Worker that is live right now ignores it, so
#      this changes nothing yet — it just means the secret is already in place
#      when the code that needs it arrives.
#   2. The app ships second. It only asks for a PIN when the server answers 401,
#      and the server is still open, so nothing prompts and nothing breaks.
#   3. The Worker ships last and the gate goes live. The next thing any phone
#      does gets a 401, asks for the PIN once, and replays the call.
#
# Ship the Worker first instead and every phone in the field goes dead until it
# happens to reload the app.
set -euo pipefail
cd "$(dirname "$0")"

WORKER_URL="https://gold-mobile-mechanic-sync.forevergoldai.workers.dev"

echo "==> 1/4  Tests"
node --test tests/*.test.mjs

echo
echo "==> 2/4  Set the owner PIN"
echo "     Six digits you will remember and can thumb-type in a driveway."
echo "     It is never written to this repo. Changing it later un-pairs every"
echo "     phone, which is how you kill a lost one."
npx wrangler secret put OWNER_PIN --config wrangler.sync.jsonc

echo
echo "==> 3/4  Ship the app to GitHub Pages (server still open — no lockout)"
git add -A
git commit -m "Put the sync API behind device pairing, and fix Talk to Anya

GET /api/jobs answered anyone who asked. The Worker URL ships in this
repository's JavaScript, so every customer name, phone number, cost basis and
clock entry was readable by anyone who looked. The PIN gate removed in 4617d89
as low-stakes is back, as a PIN-for-token exchange so it stays a one-time
ceremony per phone.

Talk to Anya recorded, counted down, and then did nothing: the ElevenLabs key
had stopped working, and the fall back to the phone's own recogniser was
guarded by a condition that is false in exactly that case.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push origin main

echo
echo "     Waiting for GitHub Pages to publish..."
for _ in $(seq 1 30); do
  sleep 10
  if curl -fsS "https://thomasg42.github.io/gold-mobile-mechanic/sync-auth.js" >/dev/null 2>&1; then
    echo "     Pages is serving sync-auth.js."
    break
  fi
  printf '.'
done

echo
echo "==> 4/4  Ship the Worker — the gate goes live here"
npx wrangler deploy --config wrangler.sync.jsonc

echo
echo "==> Verifying"
echo -n "     health:        "
curl -s "$WORKER_URL/api/health"
echo
echo -n "     anonymous jobs (must be 401): "
curl -s -o /dev/null -w '%{http_code}\n' "$WORKER_URL/api/jobs"
echo -n "     customer portal (must be 200): "
curl -s -o /dev/null -w '%{http_code}\n' "$WORKER_URL/api/portal/customers"
echo -n "     website booking (must be 200): "
curl -s -o /dev/null -w '%{http_code}\n' "$WORKER_URL/api/public/availability?weeks=3"

echo
echo "Done. On the phone: open the app, pull to refresh, enter the PIN once."
echo "If it still shows the old screen, close the tab from the app switcher and"
echo "reopen — the service worker cache name changed, so one clean load is enough."
