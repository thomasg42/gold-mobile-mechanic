import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

test("builds the Gold Mobile Mechanic application shell", async () => {
  const [layout, page, app] = await Promise.all([
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/MechanicApp.tsx", import.meta.url), "utf8"),
    access(new URL("../dist/server/index.js", import.meta.url)),
  ]);

  assert.match(layout, /Gold Mobile Mechanic — Job Clock & Invoices/);
  assert.match(page, /<MechanicApp \/>/);
  assert.match(app, /Job board/);
  assert.match(app, /New job/);
  assert.doesNotMatch(`${layout}\n${page}\n${app}`, /codex-preview|react-loading-skeleton/i);
});

test("includes the complete mechanic job workflow in source", async () => {
  const [app, viteConfig, manifest, store, timer, serviceWorker, syncWorker] = await Promise.all([
    readFile(new URL("../app/MechanicApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../vite.config.ts", import.meta.url), "utf8"),
    readFile(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"),
    readFile(new URL("../db/store.ts", import.meta.url), "utf8"),
    readFile(
      new URL("../app/api/jobs/[jobId]/timer/route.ts", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../public/sw.js", import.meta.url), "utf8"),
    readFile(new URL("../sync-worker/index.ts", import.meta.url), "utf8"),
  ]);

  for (const required of [
    "Clock in",
    "Start break",
    "Clock out · Finish job",
    "Take receipt photo",
    "Mechanic&apos;s suggestions",
    "Create invoice",
    "Share full invoice",
  ]) {
    assert.match(app, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  assert.match(viteConfig, /binding: "DB"/);
  assert.match(viteConfig, /binding: "RECEIPTS"/);
  assert.doesNotMatch(viteConfig, /hosting\.json|sites-vite-plugin/);
  assert.match(app, /JOB_CACHE_KEY/);
  assert.match(app, /PENDING_TIMER_KEY/);
  assert.match(app, /Clock history/);
  assert.match(store, /CREATE TABLE IF NOT EXISTS job_events/);
  assert.match(timer, /mutationId/);
  assert.match(timer, /replayed: true/);
  assert.match(serviceWorker, /url\.pathname\.startsWith\("\/api\/"\)/);
  assert.match(syncWorker, /GITHUB_ORIGIN/);
  assert.match(syncWorker, /eventHistory/);
  assert.match(syncWorker, /DELETE/);
  assert.equal(JSON.parse(manifest).display, "standalone");
});
