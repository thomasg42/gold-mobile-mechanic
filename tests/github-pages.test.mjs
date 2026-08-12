import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("GitHub Pages phone shell exposes the complete field workflow", async () => {
  const html = await read("docs/index.html");

  assert.match(html, /Gold Mobile Mechanic/);
  assert.match(html, /New job/);
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
  assert.match(script, /break_start/);
  assert.match(script, /break_end/);
  assert.match(script, /clock_out/);
  assert.match(script, /receiptReview/);
  assert.match(script, /invoice-at-capture|Invoice at capture|upsertInvoice/);
  assert.match(script, /partsTotal|receiptTotal/);
  assert.match(script, /Finish Project.*invoice/i);
  assert.match(script, /invoiceHtml/);
  assert.match(script, /navigator\.share/);
  assert.match(script, /mailto:/);
  assert.match(script, /backupData/);
  assert.match(script, /serviceWorker\.register/);
  assert.match(script, /SYNC_API/);
  assert.match(script, /Authorization/);
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
  assert.match(migration, /day TEXT PRIMARY KEY/);
  assert.match(migration, /job_id TEXT NOT NULL UNIQUE/);
});
