/**
 * A website (or Ken) booking must reach Thomas's inbox, and a failed email
 * must never lose the booking or change what the customer is told. Runs the
 * real worker over node:sqlite built from the real migrations, with the
 * outbound fetch to n8n stubbed.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";

const root = new URL("../", import.meta.url);
const migrationsDir = fileURLToPath(new URL("sync-worker/migrations/", root));
const NOTIFY = "https://n8n.example.com/webhook/gmm-booking-notify";
const ORIGIN = "https://thomasg42.github.io";

function makeD1() {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
    for (const s of readFileSync(`${migrationsDir}${f}`, "utf8").split(";").map((s) => s.trim()).filter(Boolean)) db.exec(s);
  }
  const isRead = (sql) => /^\s*SELECT/i.test(sql) || /RETURNING/i.test(sql);
  return {
    prepare(sql) {
      let params = [];
      const stmt = {
        bind(...values) { params = values; return stmt; },
        async first() { return db.prepare(sql).all(...params)[0] ?? null; },
        async all() { return { results: db.prepare(sql).all(...params), success: true }; },
        async run() {
          if (isRead(sql)) return { results: db.prepare(sql).all(...params), success: true };
          return { success: true, meta: db.prepare(sql).run(...params) };
        },
      };
      return stmt;
    },
    async batch(statements) { return Promise.all(statements.map((s) => s.run())); },
    _raw: db,
  };
}

async function loadWorker() {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("sync-worker/index.ts", root))],
    bundle: true, write: false, format: "esm", logLevel: "silent",
  });
  return (await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`)).default;
}

/** Runs one booking with the given outbound-fetch behaviour; returns what happened. */
async function book(worker, env, notifyBehaviour) {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return notifyBehaviour(calls.length);
  };
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p) };
  try {
    const avail = await worker.fetch(new Request("https://sync.example.com/api/public/availability", { headers: { Origin: ORIGIN } }), env, ctx);
    const day = (await avail.json()).open[0];
    const res = await worker.fetch(new Request("https://sync.example.com/api/public/bookings", {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": `203.0.113.${Math.floor(Math.random() * 200)}` },
      body: JSON.stringify({ name: "Pat Driver", phone: "406-555-0100", email: "pat@example.com", issue: "Grinding when braking",
        year: "2014", make: "Toyota", model: "Tacoma", location: "Bozeman", jobType: "Mobile", requestedDay: day }),
    }), env, ctx);
    await Promise.all(pending);
    return { res, body: await res.json(), calls, day };
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("a saved booking emails Thomas with everything the customer gave", async () => {
  const worker = await loadWorker();
  const env = { DB: makeD1(), BOOKING_NOTIFY_URL: NOTIFY };
  const { res, body, calls, day } = await book(worker, env, () => new Response('{"ok":true}', { status: 200 }));
  assert.equal(res.status, 201);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, NOTIFY);
  const sent = calls[0].body;
  assert.equal(sent.jobId, body.jobId);
  assert.match(sent.jobId, /^WEB-\d{8}-[A-Z0-9]{6}$/);
  assert.equal(sent.requestedDay, day);
  for (const [k, v] of Object.entries({ name: "Pat Driver", phone: "406-555-0100", email: "pat@example.com",
    issue: "Grinding when braking", vehicle: "2014 Toyota Tacoma", location: "Bozeman", jobType: "Mobile" })) {
    assert.equal(sent[k], v, k);
  }
});

test("a failed email retries once and still keeps the booking and the 201", async () => {
  const worker = await loadWorker();
  const env = { DB: makeD1(), BOOKING_NOTIFY_URL: NOTIFY };
  const errors = [];
  const realError = console.error;
  console.error = (m) => errors.push(String(m));
  try {
    const { res, body, calls } = await book(worker, env, () => { throw new Error("n8n down"); });
    assert.equal(res.status, 201);
    assert.equal(body.dayHeld, true);
    assert.equal(calls.length, 2, "one retry");
    assert.equal(errors.length, 2, "both attempts logged");
    const row = env.DB._raw.prepare("SELECT id FROM jobs WHERE id = ?").get(body.jobId);
    assert.ok(row, "booking saved even though the email failed");
  } finally {
    console.error = realError;
  }
});

test("with no BOOKING_NOTIFY_URL nothing is sent", async () => {
  const worker = await loadWorker();
  const env = { DB: makeD1() };
  const { res, calls } = await book(worker, env, () => new Response("{}", { status: 200 }));
  assert.equal(res.status, 201);
  assert.equal(calls.length, 0);
});
