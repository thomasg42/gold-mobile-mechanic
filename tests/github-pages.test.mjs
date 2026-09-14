import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("GitHub Pages phone shell exposes the complete field workflow", async () => {
  const html = await read("docs/index.html");

  assert.match(html, /Gold Mobile Mechanic/);
  // "New job" until 2026-09-12, when the Anya build renamed it. Pin the id as
  // well as the label: the id is what app.js binds to, and a test that only
  // knows the wording goes stale every time the wording improves.
  assert.match(html, /id="newJobButton"/);
  assert.match(html, /Add invoice/);
  assert.match(html, /Talk to Anya/);
  assert.match(html, /Customer name/);
  assert.match(html, /Vehicle/);
  assert.match(html, /Agreed work/);
  assert.match(html, /Approved materials/);
  assert.match(html, /capture="environment"/);
  assert.match(html, /Backup data/);
  assert.match(html, /Permanent cloud ledger/);
  assert.match(html, /Sync now/);
  assert.match(html, /manifest\.webmanifest/);
  assert.match(html, /apple-touch-icon/);
});

test("GitHub phone app syncs durable jobs, receipts, and clock history", async () => {
  const script = await read("docs/app.js");

  assert.match(script, /localStorage/);
  assert.match(script, /indexedDB/);
  assert.match(script, /clock_in/);
  assert.match(script, /clock_out/);
  // Two clock states only. Breaks were removed: no code path may start one.
  assert.doesNotMatch(script, /data-timer-action="break_/);
  assert.doesNotMatch(script, /status = "on_break"/);
  assert.doesNotMatch(script, /kind: "break"/);
  // Every clock event is written and pushed on its own the moment it happens.
  assert.match(script, /function logClockEvent/);
  assert.match(script, /\/events`/);
  assert.match(script, /PENDING_EVENTS_STORAGE/);
  assert.match(script, /receiptReview/);
  assert.match(script, /invoice-at-capture|Invoice at capture|upsertInvoice/);
  assert.match(script, /partsTotal|receiptTotal/);
  assert.match(script, /Finish Project.*invoice/i);
  assert.match(script, /invoiceHtml/);
  assert.match(script, /navigator\.share/);
  assert.match(script, /mailto:/);
  assert.match(script, /backupData/);
  assert.match(script, /serviceWorker\.register/);
  // Every cloud call funnels through one wrapper, and that wrapper goes through
  // the pairing module rather than calling `fetch` itself.
  //
  // This assertion used to say the opposite. The owner PIN was removed in
  // 4617d89 ("App is low-stakes; open access is fine"), and this file was
  // edited to match — which left the test agreeing with the hole instead of
  // catching it. `GET /api/jobs` then served every customer's name, phone,
  // cost basis and clock ledger to anyone who read the Worker URL out of this
  // repository. CORS is not a gate: it binds browsers, and curl is not one.
  assert.match(script, /async function cloudFetch\(path, options/);
  assert.match(script, /window\.GMMAuth\.request/);
  assert.doesNotMatch(script, /fetch\(`\$\{SYNC_API\}/,
    "app.js must not reach the sync API around the pairing module");

  const auth = await read("docs/sync-auth.js");
  assert.match(auth, /Authorization/);
  assert.match(auth, /Bearer/);
  assert.match(auth, /\/api\/pair/);
  // A 401 has to re-pair and retry, or locking the Worker would strand every
  // phone still running the previous build until someone reinstalled the app.
  assert.match(auth, /401/);
  // The PIN is a pairing credential, never a stored one.
  assert.doesNotMatch(auth, /setItem\(\s*["'`]gmm-pin/, "the PIN itself is never persisted");

  const shell = await read("docs/index.html");
  assert.match(shell, /<script src="\.\/sync-auth\.js"><\/script>[\s\S]*<script src="\.\/app\.js">/,
    "sync-auth.js must load before app.js");
  const worker = await read("docs/sw.js");
  assert.match(worker, /"\.\/sync-auth\.js"/, "the offline shell must cache the pairing module");
  assert.match(script, /PENDING_JOBS_STORAGE/);
  assert.match(script, /PENDING_RECEIPTS_STORAGE/);
  assert.match(script, /eventHistory/);
  assert.match(script, /Clock history/);
  assert.doesNotMatch(script, /CLOUD_APP_URL|chatgpt\.site/);
  assert.doesNotMatch(script, /job\.status !== "completed" \|\| !job\.receiptReview/);
});

test("Pages assets are project-relative and name GitHub Pages as the public home", async () => {
  const files = await Promise.all([
    read("README.md"),
    read("docs/index.html"),
    read("docs/app.js"),
    read("docs/styles.css"),
    read("docs/manifest.webmanifest"),
    read("docs/sw.js")
  ]);
  const manifest = JSON.parse(files[4]);

  assert.equal(manifest.start_url, "./");
  assert.equal(manifest.scope, "./");
  assert.equal(manifest.display, "standalone");
  assert.deepEqual(manifest.icons.map((icon) => icon.sizes), ["192x192", "512x512"]);
  assert.match(files[0], /thomasg42\.github\.io\/gold-mobile-mechanic/);
  assert.doesNotMatch(files.join("\n"), /chatgpt\.site/);
});

test("Worker owns the public one-car-per-day booking board", async () => {
  const worker = await read("sync-worker/index.ts");
  const migration = await read("sync-worker/migrations/0003_website_booking_board.sql");

  assert.match(worker, /\/api\/public\/availability/);
  assert.match(worker, /\/api\/public\/bookings/);
  assert.match(worker, /const BOOKING_DAYS = new Set\(\[0, 1, 2, 3\]\)/);
  assert.match(worker, /INSERT INTO website_bookings/);
  assert.match(worker, /env\.DB\.batch/);
  assert.match(worker, /reason: "day_taken"/);
  assert.match(worker, /source: "gold-mobile-mechanic-site"/);
  assert.match(worker, /request\.headers\.get\("Origin"\) && !allowedOrigin\(request\)/);
  assert.match(migration, /day TEXT PRIMARY KEY/);
  assert.match(migration, /job_id TEXT NOT NULL UNIQUE/);
});
