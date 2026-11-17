/**
 * Estimate -> customer approval -> invoice, through the real Worker on a real
 * SQLite D1. Pins down: the public estimate view leaks no contact details,
 * every line must be answered and signed, an answer is final for one link,
 * a stale phone push cannot erase the customer's answer, and neither writer
 * can erase the other when they land at the same moment (compare-and-swap).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { TEST_PIN, authHeader } from "./pair-helper.mjs";

const root = new URL("../", import.meta.url);
const migrationsDir = fileURLToPath(new URL("sync-worker/migrations/", root));
const CAS_UPDATE = /^UPDATE jobs SET data = \?1, updated_at = \?2 WHERE id = \?3 AND data = \?4$/;

function makeD1(migrations) {
  const db = new DatabaseSync(":memory:");
  for (const sql of migrations) {
    for (const statement of sql.split(";").map((s) => s.trim()).filter(Boolean)) db.exec(statement);
  }
  const isRead = (sql) => /^\s*SELECT/i.test(sql) || /RETURNING/i.test(sql);
  const d1 = {
    // Runs just before the next compare-and-swap UPDATE: a write by "the other
    // writer" landing between that request's read and its write.
    beforeNextCas: null,
    prepare(sql) {
      let params = [];
      const stmt = {
        bind(...values) { params = values; return stmt; },
        async first() { return db.prepare(sql).all(...params)[0] ?? null; },
        async all() { return { results: db.prepare(sql).all(...params), success: true }; },
        async run() {
          if (CAS_UPDATE.test(sql.trim()) && d1.beforeNextCas) d1.beforeNextCas();
          if (isRead(sql)) return { results: db.prepare(sql).all(...params), success: true };
          return { success: true, meta: db.prepare(sql).run(...params) };
        }
      };
      return stmt;
    },
    async batch(statements) { return Promise.all(statements.map((s) => s.run())); },
    _raw: db
  };
  return d1;
}

async function loadWorker() {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("sync-worker/index.ts", root))],
    bundle: true, write: false, format: "esm", logLevel: "silent"
  });
  return (await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`)).default;
}

async function setup() {
  const worker = await loadWorker();
  const migrations = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()
    .map((f) => readFileSync(`${migrationsDir}${f}`, "utf8"));
  const env = { DB: makeD1(migrations), OWNER_PIN: TEST_PIN };
  const call = (path, { method = "GET", body, auth = true } = {}) =>
    worker.fetch(new Request(`https://sync.example.com${path}`, {
      method,
      headers: { Origin: "https://thomasg42.github.io", "Content-Type": "application/json", ...(auth ? authHeader() : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    }), env);
  const stored = (id) => JSON.parse(env.DB._raw.prepare("SELECT data FROM jobs WHERE id = ?").get(id).data);
  const rawWrite = (id, mutate) => {
    const job = stored(id);
    mutate(job);
    env.DB._raw.prepare("UPDATE jobs SET data = ? WHERE id = ?").run(JSON.stringify(job), id);
  };
  return { env, call, stored, rawWrite };
}

function sentEstimate(token, over = {}) {
  return {
    status: "sent", token, sentAt: "2026-11-16T15:00:00.000Z", notes: "Good for 14 days",
    taxRatePct: 0, shopSuppliesPct: 5, depositCents: 5000,
    lines: [
      { id: "l1", kind: "labor", description: "Front brakes", quantity: 2, unitCents: 10000, decision: "pending" },
      { id: "l2", kind: "part", description: "Pad set", quantity: 1, unitCents: 6000, decision: "pending" },
      { id: "l3", kind: "part", description: "Rotors", quantity: 2, unitCents: 7000, decision: "pending" }
    ],
    ...over
  };
}

function jobWith(id, estimate, over = {}) {
  return {
    id, customerName: "Ada Lin", customerPhone: "406 555 0101", customerEmail: "ada@example.com",
    status: "draft", vehicleMake: "Toyota", vehicleModel: "Camry", laborRateCents: 10000,
    updatedAt: "2026-11-16T15:00:00.000Z", estimate, ...over
  };
}

const ANSWER = { decisions: { l1: "approved", l2: "approved", l3: "declined" }, signatureName: "Ada Lin", agree: true };

test("estimate approval round trip", async () => {
  const { call } = await setup();
  const TOKEN = "AbCdEfGhIjKlMnOpQrStUv";
  const job = jobWith("GMM-20261116-AAAA", sentEstimate(TOKEN));
  let r = await call(`/api/jobs/${job.id}`, { method: "PUT", body: job });
  assert.equal(r.status, 200);

  // Public view: no auth, no contact details, first name only.
  r = await call(`/api/portal/estimates/${TOKEN}`, { auth: false });
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.ok(!text.includes("555") && !text.includes("ada@example.com") && !text.includes("Lin"));
  const view = JSON.parse(text).estimate;
  assert.equal(view.firstName, "Ada");
  assert.equal(view.lines[2].amountCents, 14000);

  // A guessed or malformed token finds nothing.
  assert.equal((await call(`/api/portal/estimates/nope`, { auth: false })).status, 404);
  assert.equal((await call(`/api/portal/estimates/ZZZZZZZZZZZZZZZZZZZZZZ`, { auth: false })).status, 404);

  // Every line answered, a name, and the box ticked.
  r = await call(`/api/portal/estimates/${TOKEN}/decision`, { method: "POST", auth: false,
    body: { ...ANSWER, decisions: { l1: "approved" } } });
  assert.equal(r.status, 400);
  r = await call(`/api/portal/estimates/${TOKEN}/decision`, { method: "POST", auth: false,
    body: { ...ANSWER, agree: false } });
  assert.equal(r.status, 400);
  r = await call(`/api/portal/estimates/${TOKEN}/decision`, { method: "POST", auth: false,
    body: { ...ANSWER, signatureName: " " } });
  assert.equal(r.status, 400);
  r = await call(`/api/portal/estimates/${TOKEN}/decision`, { method: "POST", auth: false, body: ANSWER });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).estimate.status, "responded");

  // Final for this link.
  r = await call(`/api/portal/estimates/${TOKEN}/decision`, { method: "POST", auth: false,
    body: { ...ANSWER, decisions: { l1: "declined", l2: "declined", l3: "declined" }, signatureName: "Someone" } });
  assert.equal(r.status, 409);

  // A phone that never pulled pushes its stale "sent" copy, newer clock: the answer survives.
  r = await call(`/api/jobs/${job.id}`, { method: "PUT",
    body: { ...job, agreedWork: "edited on phone", updatedAt: "2026-11-16T16:00:00.000Z" } });
  const merged = (await r.json()).job;
  assert.equal(merged.agreedWork, "edited on phone");
  assert.equal(merged.estimate.status, "responded");
  assert.equal(merged.estimate.signatureName, "Ada Lin");
  assert.deepEqual(merged.estimate.lines.map((l) => l.decision), ["approved", "approved", "declined"]);

  // Re-sending with a new token deliberately starts over; the old link dies.
  const resent = { ...merged.estimate, status: "sent", token: "NewTokenNewTokenNewTok", respondedAt: null,
    signatureName: "", lines: merged.estimate.lines.map((l) => ({ ...l, decision: "pending" })) };
  r = await call(`/api/jobs/${job.id}`, { method: "PUT",
    body: { ...merged, estimate: resent, updatedAt: "2026-11-16T17:00:00.000Z" } });
  assert.equal((await r.json()).job.estimate.status, "sent");
  assert.equal((await call(`/api/portal/estimates/${TOKEN}`, { auth: false })).status, 404);

  // Pulled back to draft: the link stops opening at all.
  r = await call(`/api/jobs/${job.id}`, { method: "PUT",
    body: { ...merged, estimate: { ...resent, status: "draft", token: "" }, updatedAt: "2026-11-16T17:30:00.000Z" } });
  assert.equal(r.status, 200);
  assert.equal((await call(`/api/portal/estimates/NewTokenNewTokenNewTok`, { auth: false })).status, 404);

  // The portal shows tax/supplies/deposit, the balance, and flat labor on a filed invoice.
  const invoiced = {
    ...merged, estimate: resent, status: "invoiced", updatedAt: "2026-11-16T18:00:00.000Z",
    invoice: { invoiceNumber: "GMM-INV-20261116-AAAA", createdAt: "2026-11-16T18:00:00.000Z",
      laborCents: 20000, materialsCents: 0, quotedCents: 6000, shopSuppliesCents: 1000, taxCents: 0,
      totalCents: 27000, depositCents: 5000, balanceDueCents: 22000, workSeconds: 0, flatLabor: true }
  };
  await call(`/api/jobs/${job.id}`, { method: "PUT", body: invoiced });
  const dir = await (await call(`/api/portal/customers`, { auth: false })).json();
  const profile = await (await call(`/api/portal/customers/${dir.customers[0].id}`, { auth: false })).json();
  const filed = profile.customer.invoices[0];
  assert.equal(filed.balanceDueCents, 22000);
  assert.equal(filed.shopSuppliesCents, 1000);
  assert.equal(filed.flatLabor, true);
});

test("an estimate with nothing on it cannot be signed", async () => {
  const { call } = await setup();
  const TOKEN = "EmptyEmptyEmptyEmpty01";
  const job = jobWith("GMM-20261116-EMPT", sentEstimate(TOKEN, { lines: [] }));
  await call(`/api/jobs/${job.id}`, { method: "PUT", body: job });
  const r = await call(`/api/portal/estimates/${TOKEN}/decision`, { method: "POST", auth: false,
    body: { decisions: {}, signatureName: "Ada Lin", agree: true } });
  assert.equal(r.status, 409);
});

test("a phone save landing mid-signature is kept, and so is the signature", async () => {
  const { env, call, stored, rawWrite } = await setup();
  const TOKEN = "RaceRaceRaceRaceRace01";
  const job = jobWith("GMM-20261116-RAC1", sentEstimate(TOKEN));
  await call(`/api/jobs/${job.id}`, { method: "PUT", body: job });

  env.DB.beforeNextCas = () => {
    env.DB.beforeNextCas = null;
    rawWrite(job.id, (row) => { row.agreedWork = "phone edit during signing"; });
  };
  const r = await call(`/api/portal/estimates/${TOKEN}/decision`, { method: "POST", auth: false, body: ANSWER });
  assert.equal(r.status, 200);
  const row = stored(job.id);
  assert.equal(row.agreedWork, "phone edit during signing", "the phone's write survived");
  assert.equal(row.estimate.status, "responded", "and so did the signature");
  assert.equal(row.estimate.signatureName, "Ada Lin");
});

test("a signature landing mid-phone-save is kept, and so is the phone's change", async () => {
  const { env, call, stored, rawWrite } = await setup();
  const TOKEN = "RaceRaceRaceRaceRace02";
  const job = jobWith("GMM-20261116-RAC2", sentEstimate(TOKEN));
  await call(`/api/jobs/${job.id}`, { method: "PUT", body: job });

  env.DB.beforeNextCas = () => {
    env.DB.beforeNextCas = null;
    rawWrite(job.id, (row) => {
      row.estimate = { ...row.estimate, status: "responded", respondedAt: "2026-11-16T15:30:00.000Z",
        signatureName: "Ada Lin", lines: row.estimate.lines.map((l) => ({ ...l, decision: "approved" })) };
    });
  };
  const r = await call(`/api/jobs/${job.id}`, { method: "PUT",
    body: { ...job, agreedWork: "phone change", updatedAt: "2026-11-16T16:00:00.000Z" } });
  assert.equal(r.status, 200);
  const row = stored(job.id);
  assert.equal(row.agreedWork, "phone change", "the phone's change landed");
  assert.equal(row.estimate.status, "responded", "the customer's answer was not erased");
  assert.deepEqual(row.estimate.lines.map((l) => l.decision), ["approved", "approved", "approved"]);
  assert.deepEqual((await r.json()).job.estimate.signatureName, "Ada Lin", "the phone is handed the answer");
});

test("a job row that keeps changing gets a 503, never a blind overwrite", async () => {
  const { env, call, stored, rawWrite } = await setup();
  const job = jobWith("GMM-20261116-BUSY", null);
  await call(`/api/jobs/${job.id}`, { method: "PUT", body: job });

  let interferences = 0;
  env.DB.beforeNextCas = () => {
    interferences += 1;
    rawWrite(job.id, (row) => { row.agreedWork = `other writer ${interferences}`; });
  };
  const r = await call(`/api/jobs/${job.id}`, { method: "PUT",
    body: { ...job, agreedWork: "phone", updatedAt: "2026-11-16T16:00:00.000Z" } });
  env.DB.beforeNextCas = null;
  assert.equal(r.status, 503, "the phone keeps the job queued and retries");
  assert.equal(interferences, 4, "bounded retries");
  assert.equal(stored(job.id).agreedWork, "other writer 4", "nothing was overwritten blind");
});
