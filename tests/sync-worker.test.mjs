/**
 * Runs the real sync worker against a real SQLite database built from the real
 * migration files, so routing, validation, merge behaviour, and the SQL itself
 * are all exercised. Local `wrangler dev` cannot bind a port in every
 * environment, and a hand-stubbed D1 would only prove the stub.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";

const root = new URL("../", import.meta.url);
const migrationsDir = fileURLToPath(new URL("sync-worker/migrations/", root));

/** The slice of the D1 API the worker actually uses, over node:sqlite. */
function makeD1(migrations) {
  const db = new DatabaseSync(":memory:");
  for (const sql of migrations) {
    for (const statement of sql.split(";").map((s) => s.trim()).filter(Boolean)) {
      db.exec(statement);
    }
  }
  const isRead = (sql) => /^\s*SELECT/i.test(sql) || /RETURNING/i.test(sql);
  return {
    prepare(sql) {
      let params = [];
      const stmt = {
        bind(...values) { params = values; return stmt; },
        async first(_col) {
          const rows = db.prepare(sql).all(...params);
          return rows[0] ?? null;
        },
        async all() { return { results: db.prepare(sql).all(...params), success: true }; },
        async run() {
          if (isRead(sql)) return { results: db.prepare(sql).all(...params), success: true };
          const info = db.prepare(sql).run(...params);
          return { success: true, meta: info };
        }
      };
      return stmt;
    },
    async batch(statements) { return Promise.all(statements.map((s) => s.run())); },
    _raw: db
  };
}

async function loadWorker() {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("sync-worker/index.ts", root))],
    bundle: false,
    write: false,
    format: "esm",
    logLevel: "silent"
  });
  const source = result.outputFiles[0].text;
  return (await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`)).default;
}

test("sync worker records clock events durably and serves the customer portal", async () => {
  const worker = await loadWorker();
  const migrations = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()
    .map((f) => readFileSync(`${migrationsDir}${f}`, "utf8"));
  const env = { DB: makeD1(migrations) };

  const ORIGIN = "https://thomasg42.github.io";
  const call = (path, { method = "GET", body } = {}) =>
    worker.fetch(new Request(`https://sync.example.com${path}`, {
      method,
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    }), env);
  const ok = () => {};


  // ---------------------------------------------------------------- clock events
  const jobBody = (over = {}) => ({
    id: "GMM-0001", customerName: "deShaun O'Brien-Katz", customerPhone: "(406) 555-0147",
    status: "in_progress", laborRateCents: 12000, vehicleYear: "2012", vehicleMake: "Chevrolet",
    vehicleModel: "Cruze", eventHistory: [], updatedAt: new Date().toISOString(), ...over
  });

  let r = await call("/api/jobs/GMM-0001", { method: "PUT", body: jobBody() });
  assert.equal(r.status, 200); ok("job saved");

  // One clock-in, posted on its own, before any job body follows it.
  r = await call("/api/jobs/GMM-0001/events", {
    method: "POST", body: { id: "evt-1", action: "clock_in", occurredAt: "2026-08-20T15:00:00.000Z" }
  });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).recorded, true); ok("clock_in recorded on its own");

  // Replaying the same event (offline queue retry) must not duplicate it.
  await call("/api/jobs/GMM-0001/events", {
    method: "POST", body: { id: "evt-1", action: "clock_in", occurredAt: "2026-08-20T15:00:00.000Z" }
  });
  assert.equal(env.DB._raw.prepare("SELECT COUNT(*) c FROM job_events").get().c, 1);
  ok("replayed event is idempotent");

  r = await call("/api/jobs/GMM-0001/events", {
    method: "POST", body: { id: "evt-2", action: "clock_out", occurredAt: "2026-08-20T17:30:00.000Z" }
  });
  assert.equal(r.status, 200); ok("clock_out recorded on its own");

  // Breaks are not a thing any more and must be refused outright.
  r = await call("/api/jobs/GMM-0001/events", {
    method: "POST", body: { id: "evt-3", action: "break_start", occurredAt: "2026-08-20T16:00:00.000Z" }
  });
  assert.equal(r.status, 400); ok("break event rejected");

  // A phone that posted events and then syncs a STALE job body must not erase them.
  r = await call("/api/jobs/GMM-0001", { method: "PUT", body: jobBody({ eventHistory: [] }) });
  const merged = (await r.json()).job;
  assert.deepEqual(merged.eventHistory.map((e) => e.action), ["clock_in", "clock_out"]);
  ok("stale job body cannot wipe recorded clock events");

  // ------------------------------------------------- status never over-reaches
  // Syncing a clocked-out job must not silently "finish" it.
  let sr = await call("/api/jobs/GMM-0002", { method: "PUT",
    body: jobBody({ id: "GMM-0002", updatedAt: "2026-08-20T14:59:00.000Z" }) });
  await call("/api/jobs/GMM-0002/events", { method: "POST",
    body: { id: "e-a", action: "clock_in", occurredAt: "2026-08-20T15:00:00.000Z" } });
  await call("/api/jobs/GMM-0002/events", { method: "POST",
    body: { id: "e-b", action: "clock_out", occurredAt: "2026-08-20T16:00:00.000Z" } });
  sr = await call("/api/jobs/GMM-0002", { method: "PUT",
    body: jobBody({ id: "GMM-0002", status: "clocked_out", updatedAt: "2026-08-20T16:00:01.000Z" }) });
  let sj = (await sr.json()).job;
  assert.equal(sj.status, "clocked_out");
  assert.equal(sj.endedAt, null); ok("clock_out leaves the job open, with no end date");

  // Clocking back in after a clock out returns it to the clock.
  await call("/api/jobs/GMM-0002/events", { method: "POST",
    body: { id: "e-c", action: "clock_in", occurredAt: "2026-08-20T18:00:00.000Z" } });
  sr = await call("/api/jobs/GMM-0002", { method: "PUT",
    body: jobBody({ id: "GMM-0002", status: "in_progress", updatedAt: "2026-08-20T18:00:01.000Z" }) });
  assert.equal((await sr.json()).job.status, "in_progress"); ok("clock back in resumes work");

  // Finishing sticks, even though the last clock event is still a clock out.
  await call("/api/jobs/GMM-0002/events", { method: "POST",
    body: { id: "e-d", action: "clock_out", occurredAt: "2026-08-20T19:00:00.000Z" } });
  sr = await call("/api/jobs/GMM-0002", { method: "PUT", body: jobBody({
    id: "GMM-0002", status: "invoiced", endedAt: "2026-08-20T19:00:00.000Z",
    updatedAt: "2026-08-20T19:00:01.000Z" }) });
  assert.equal((await sr.json()).job.status, "invoiced"); ok("a finished job is not reopened by its clock out");

  // ---------------------------------------------------------------------- portal
  // Nothing is visible until the invoice is actually filed.
  r = await call("/api/portal/lookup", { method: "POST", body: { firstName: "deShaun", phone: "4065550147" } });
  assert.deepEqual((await r.json()).invoices, []); ok("open job exposes no invoice");

  await call("/api/jobs/GMM-0001", { method: "PUT", body: jobBody({
    status: "invoiced", updatedAt: "2026-08-20T18:00:01.000Z", agreedWork: "Oil filter housing", suggestions: "Rear pads soon",
    invoice: { invoiceNumber: "GMM-INV-0001", createdAt: "2026-08-20T18:00:00.000Z",
      laborCents: 30000, materialsCents: 8000, totalCents: 38000, workSeconds: 9000 }
  }) });

  // Sign in the way a customer would type it: messy formatting, any casing.
  r = await call("/api/portal/lookup", { method: "POST", body: { firstName: "  DESHAUN ", phone: "1 (406) 555-0147" } });
  let payload = await r.json();
  assert.equal(payload.invoices.length, 1);
  assert.equal(payload.invoices[0].totalCents, 38000);
  assert.equal(payload.invoices[0].partsCents, 8000);
  assert.equal(payload.invoices[0].vehicle, "2012 Chevrolet Cruze");
  ok("customer sees their own filed invoice");

  // The portal must never hand back the internal ledger.
  const leaked = Object.keys(payload.invoices[0]).filter((k) =>
    ["receipts", "eventHistory", "timeEntries", "laborRateCents", "materials"].includes(k));
  assert.deepEqual(leaked, []); ok("no internal ledger fields leak");

  // Right phone, wrong person: no match.
  r = await call("/api/portal/lookup", { method: "POST", body: { firstName: "Marcus", phone: "4065550147" } });
  assert.deepEqual((await r.json()).invoices, []); ok("wrong first name returns nothing");

  // Right name, wrong number: no match.
  r = await call("/api/portal/lookup", { method: "POST", body: { firstName: "deShaun", phone: "4065559999" } });
  assert.deepEqual((await r.json()).invoices, []); ok("wrong phone returns nothing");

  r = await call("/api/portal/lookup", { method: "POST", body: { firstName: "deShaun", phone: "406555" } });
  assert.equal(r.status, 400); ok("partial phone refused");

  // Guessing is throttled.
  let throttled = false;
  for (let i = 0; i < 14; i += 1) {
    const attempt = await call("/api/portal/lookup", { method: "POST", body: { firstName: "guess", phone: "4065550147" } });
    if (attempt.status === 429) { throttled = true; break; }
  }
  assert.equal(throttled, true); ok("repeat sign-in guessing is rate limited");
});
