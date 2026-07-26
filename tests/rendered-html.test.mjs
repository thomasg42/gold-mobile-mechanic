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
  const [app, hosting, manifest] = await Promise.all([
    readFile(new URL("../app/MechanicApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../.openai/hosting.json", import.meta.url), "utf8"),
    readFile(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"),
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

  assert.equal(JSON.parse(hosting).d1, "DB");
  assert.equal(JSON.parse(hosting).r2, "RECEIPTS");
  assert.match(JSON.parse(hosting).project_id, /^appgprj_/);
  assert.equal(JSON.parse(manifest).display, "standalone");
});
