/**
 * The gate on the sync API.
 *
 * Written against the real Worker and a real SQLite database, because the
 * defect being pinned here was a ROUTING fact, not a logic one: `GET
 * /api/jobs` answered anybody who asked, and every customer name, phone
 * number, cost basis and clock entry came back to an unauthenticated caller
 * who had read the Worker URL out of the public repository's JavaScript.
 *
 * What each block is holding in place:
 *   - the protected routes refuse an anonymous caller, all of them, by method
 *   - the public ones (health, the website's booking form, the customer
 *     invoice portal) are NOT caught by the gate and still answer
 *   - a Worker deployed without its secret fails CLOSED
 *   - pairing is rate-limited, so six digits cannot simply be enumerated
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { TEST_PIN, authHeader, deviceToken } from "./pair-helper.mjs";

const root = new URL("../", import.meta.url);
const migrationsDir = fileURLToPath(new URL("sync-worker/migrations/", root));
const ORIGIN = "https://thomasg42.github.io";

function makeD1(migrations) {
  const db = new DatabaseSync(":memory:");
  for (const sql of migrations) {
    for (const statement of sql.split(";").map((s) => s.trim()).filter(Boolean)) db.exec(statement);
  }
  return {
    prepare(sql) {
      let params = [];
      const stmt = {
        bind(...values) { params = values; return stmt; },
        async first() { return db.prepare(sql).all(...params)[0] ?? null; },
        async all() { return { results: db.prepare(sql).all(...params), success: true }; },
        async run() {
          if (/^\s*SELECT/i.test(sql) || /RETURNING/i.test(sql)) {
            return { results: db.prepare(sql).all(...params), success: true };
          }
          return { success: true, meta: db.prepare(sql).run(...params) };
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
    bundle: true, write: false, format: "esm", logLevel: "silent"
  });
  return (await import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`
  )).default;
}

const migrations = () => readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()
  .map((f) => readFileSync(`${migrationsDir}${f}`, "utf8"));

test("the sync API refuses an unpaired caller and still serves the public routes", async () => {
  const worker = await loadWorker();
  const env = { DB: makeD1(migrations()), OWNER_PIN: TEST_PIN, ELEVENLABS_API_KEY: "el-test" };

  const call = (path, { method = "GET", body, headers = {}, origin = ORIGIN } = {}) =>
    worker.fetch(new Request(`https://sync.example.com${path}`, {
      method,
      headers: { ...(origin ? { Origin: origin } : {}), "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body)
    }), env);

  // A real record to try to steal, filed so the portal will publish it too.
  const job = {
    id: "GMM-9001", customerName: "Josh Perkins", customerPhone: "(406) 555-0110",
    customerEmail: "josh@example.com", status: "invoiced", laborRateCents: 12500,
    vehicleYear: "2004", vehicleMake: "Chevrolet", vehicleModel: "Suburban",
    invoice: { invoiceNumber: "INV-9001", createdAt: "2026-09-01T10:00:00.000Z", totalCents: 42000 },
    eventHistory: [], updatedAt: "2026-09-01T10:00:00.000Z"
  };
  assert.equal((await call("/api/jobs/GMM-9001", { method: "PUT", body: job, headers: authHeader() })).status, 200);

  // ------------------------------------------- every protected route, anonymous
  const protectedRoutes = [
    ["/api/jobs", "GET"],
    ["/api/jobs/GMM-9001", "PUT"],
    ["/api/jobs/GMM-9001", "DELETE"],
    ["/api/jobs/GMM-9001/events", "POST"],
    ["/api/jobs/GMM-9001/receipts/r1", "GET"],
    ["/api/jobs/GMM-9001/receipts/r1", "PUT"],
    ["/api/voice/tts", "POST"],
    ["/api/voice/stt", "POST"],
    ["/api/assistant/invoice", "POST"],
    ["/api/assistant/chat", "POST"]
  ];
  for (const [path, method] of protectedRoutes) {
    const anonymous = await call(path, { method, body: method === "GET" ? undefined : {} });
    assert.equal(anonymous.status, 401, `${method} ${path} must refuse an unpaired caller`);
  }

  // The leak itself: no customer detail may appear in the refusal.
  const leak = await call("/api/jobs");
  const text = await leak.text();
  assert.doesNotMatch(text, /Perkins|555-0110|josh@example\.com/, "a 401 must not carry the data");

  // ------------------------------------------------- a forged token is refused
  assert.equal((await call("/api/jobs", { headers: { Authorization: "Bearer test-device-0001.aaaa" } })).status,
    401, "a made-up signature is not a token");
  assert.equal((await call("/api/jobs", { headers: { Authorization: `Bearer ${deviceToken("000000")}` } })).status,
    401, "a token signed with the wrong PIN is not a token");
  // The id is signed material: re-pointing a valid signature at another device
  // must not authenticate.
  const [, signature] = deviceToken().split(".");
  assert.equal((await call("/api/jobs", { headers: { Authorization: `Bearer other-device.${signature}` } })).status,
    401, "a signature cannot be moved to a different device id");

  // ------------------------------------------------------ the paired phone works
  const paired = await call("/api/jobs", { headers: authHeader() });
  assert.equal(paired.status, 200);
  assert.equal((await paired.json()).jobs.length, 1, "the operator still gets the real list");

  // ------------------------------------ the public routes are NOT behind the gate
  const health = await call("/api/health");
  assert.equal(health.status, 200);
  assert.equal((await health.json()).locked, true, "health reports the gate is configured");

  assert.equal((await call("/api/public/availability?weeks=3")).status, 200,
    "the website's booking calendar must keep working");

  const directory = await call("/api/portal/customers");
  assert.equal(directory.status, 200, "the customer invoice portal is open by design");
  const listed = await directory.json();
  assert.equal(listed.customers.length, 1);
  // The portal is public on purpose, so what it withholds is load-bearing.
  assert.doesNotMatch(JSON.stringify(listed), /555-0110|josh@example\.com/,
    "the open portal must never publish contact details");

  // --------------------------------------------- pairing trades a PIN for a token
  const pair = (body, origin = ORIGIN) => call("/api/pair", { method: "POST", body, origin });

  const wrong = await pair({ pin: "000000", deviceId: "phone-a" });
  assert.equal(wrong.status, 401, "a bad PIN does not pair");

  const good = await pair({ pin: TEST_PIN, deviceId: "phone-a" });
  assert.equal(good.status, 200);
  const { token } = await good.json();
  assert.equal(token, deviceToken(TEST_PIN, "phone-a"), "the Worker and the app agree on the token");

  const withNewPhone = await call("/api/jobs", { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(withNewPhone.status, 200, "a freshly paired phone can sync immediately");

  assert.equal((await pair({ pin: TEST_PIN, deviceId: "phone-b" }, "https://evil.example")).status, 403,
    "another site cannot pair itself");
  assert.equal((await pair({ pin: TEST_PIN, deviceId: "phone.b" })).status, 400,
    "a device id cannot smuggle the token separator");

  // -------------------------------------------------- brute force is capped
  // Eight tries an hour per caller. The limiter counts every attempt, so the
  // ninth is refused whether or not it happens to be right.
  let refusals = 0;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if ((await pair({ pin: "999999", deviceId: "phone-c" })).status === 429) refusals += 1;
  }
  assert.ok(refusals > 0, "a six-digit PIN must not be enumerable at full speed");
});

test("a Worker deployed without its secret fails closed, not open", async () => {
  const worker = await loadWorker();
  // The exact shape of the original defect: the code is deployed, the secret is
  // not. The dangerous outcome is that it quietly serves everybody.
  const env = { DB: makeD1(migrations()) };
  const call = (path, headers = {}) =>
    worker.fetch(new Request(`https://sync.example.com${path}`, {
      headers: { Origin: ORIGIN, ...headers }
    }), env);

  assert.equal((await call("/api/jobs")).status, 401, "no secret must not mean no lock");
  assert.equal((await call("/api/jobs", authHeader())).status, 401,
    "and a token minted under some other PIN must not open it either");

  const health = await call("/api/health");
  assert.equal((await health.json()).locked, false, "health says the secret is missing");

  const pair = await worker.fetch(new Request("https://sync.example.com/api/pair", {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify({ pin: "406117", deviceId: "phone-a" })
  }), env);
  assert.equal(pair.status, 503, "and pairing says so plainly rather than issuing a useless token");
});
