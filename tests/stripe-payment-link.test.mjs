/**
 * The Stripe card link, end to end through the real Worker and real SQL, with
 * only Stripe itself stubbed at `fetch`. What matters here is money: the fee
 * math leaves Thomas whole, the amount comes from the filed invoice and not
 * the request, and a double tap never mints a second payable link.
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

function makeD1() {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(`${migrationsDir}${file}`, "utf8");
    for (const statement of sql.split(";").map((s) => s.trim()).filter(Boolean)) db.exec(statement);
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
        }
      };
      return stmt;
    },
    async batch(statements) { return Promise.all(statements.map((s) => s.run())); },
    _raw: db
  };
}

async function loadWorkerModule() {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("sync-worker/index.ts", root))],
    bundle: true, write: false, format: "esm", logLevel: "silent"
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

// wrangler appends its own bookkeeping INSERT after each migration file, so a
// file whose last statement has no semicolon fails on the live database while
// passing every local test (which splits on semicolons). 0005 shipped that way.
test("every migration ends its last statement", () => {
  for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"))) {
    const body = readFileSync(`${migrationsDir}${file}`, "utf8")
      .replace(/--.*$/gm, "").trim();
    assert.ok(body.endsWith(";"), `${file} must end with a semicolon`);
  }
});

/** Stripe's fee on a charge, the way Stripe rounds it. */
const stripeTakes = (gross) => Math.round(gross * 0.029) + 30;

test("card fee leaves the shop whole and respects the 3% cap", async () => {
  const { cardFeeFor } = await loadWorkerModule();

  // Uncapped: the grossed-up fee nets the exact bill after Stripe's cut.
  for (const bill of [5000, 10000, 48750, 123456, 250000]) {
    const fee = cardFeeFor(bill, { capPercent: 0 });
    assert.ok(fee.totalCents - stripeTakes(fee.totalCents) >= bill, `nets the bill on ${bill}`);
    assert.ok(fee.totalCents - stripeTakes(fee.totalCents) <= bill + 1, `no overcharge on ${bill}`);
  }
  assert.deepEqual(cardFeeFor(10000, { capPercent: 0 }),
    { invoiceCents: 10000, feeCents: 330, totalCents: 10330, capped: false });

  // Default cap is 3% of the bill — a card-network surcharge ceiling.
  assert.deepEqual(cardFeeFor(10000),
    { invoiceCents: 10000, feeCents: 300, totalCents: 10300, capped: true });

  // An Instant Payout fee is grossed up on top, so the DEPOSIT equals the bill.
  const instant = cardFeeFor(10000, { capPercent: 0, payoutPercent: 1.5 });
  const deposit = Math.floor((instant.totalCents - stripeTakes(instant.totalCents)) * 0.985);
  assert.ok(deposit >= 10000 - 1, "instant payout deposit covers the bill");
});

test("payment link route builds one link from the filed invoice", async () => {
  const worker = (await loadWorkerModule()).default;
  const env = { DB: makeD1(), OWNER_PIN: TEST_PIN };
  const ORIGIN = "https://thomasg42.github.io";
  const call = (path, { method = "GET", body, headers = {} } = {}) =>
    worker.fetch(new Request(`https://sync.example.com${path}`, {
      method,
      headers: { Origin: ORIGIN, "Content-Type": "application/json", ...authHeader(), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body)
    }), env);

  const stripeCalls = [];
  const realFetch = globalThis.fetch;
  let linkCounter = 0;
  globalThis.fetch = async (url, init = {}) => {
    const target = new URL(String(url));
    assert.equal(target.hostname, "api.stripe.com");
    const form = new URLSearchParams(init.body || "");
    stripeCalls.push({ method: init.method, path: target.pathname, form, query: target.searchParams,
      key: init.headers?.["Idempotency-Key"], auth: init.headers?.Authorization });
    const reply = (payload) => new Response(JSON.stringify(payload), { status: 200 });
    if (target.pathname === "/v1/customers" && init.method === "GET") return reply({ data: [] });
    if (target.pathname === "/v1/customers") return reply({ id: "cus_test1" });
    if (target.pathname === "/v1/prices") return reply({ id: `price_${form.get("unit_amount")}` });
    if (target.pathname === "/v1/payment_links") {
      linkCounter += 1;
      return reply({ id: `plink_${linkCounter}`, url: `https://buy.stripe.com/test_${linkCounter}` });
    }
    if (target.pathname.startsWith("/v1/payment_links/")) return reply({ active: false });
    return new Response("{}", { status: 404 });
  };

  try {
    const job = {
      id: "GMM-0042", customerName: "Josh Example", customerEmail: "josh@example.com",
      customerPhone: "(406) 555-0101", vehicleYear: "2015", vehicleMake: "Chevrolet",
      vehicleModel: "Suburban", status: "invoiced", eventHistory: [],
      invoice: { invoiceNumber: "GMM-INV-0042", totalCents: 48750, laborCents: 36000,
        materialsCents: 12750, createdAt: "2026-10-16T18:00:00.000Z" },
      updatedAt: "2026-10-16T18:00:00.000Z"
    };

    // Not configured: a loud 503, not a broken link.
    let r = await call("/api/jobs/GMM-0042/payment-link", { method: "POST", body: {} });
    assert.equal(r.status, 503);

    env.STRIPE_SECRET_KEY = "rk_test_fake";

    // Behind the PIN gate and the app origin.
    r = await call("/api/jobs/GMM-0042/payment-link", { method: "POST", body: {}, headers: { Authorization: "" } });
    assert.equal(r.status, 401);
    r = await call("/api/jobs/GMM-0042/payment-link", { method: "POST", body: {}, headers: { Origin: "https://evil.example" } });
    assert.equal(r.status, 403);

    // Unsynced job, then an unfiled one: refused, never guessed.
    r = await call("/api/jobs/GMM-0042/payment-link", { method: "POST", body: {} });
    assert.equal(r.status, 404);
    await call("/api/jobs/GMM-0042", { method: "PUT", body: { ...job, status: "completed", invoice: null } });
    r = await call("/api/jobs/GMM-0042/payment-link", { method: "POST", body: {} });
    assert.equal(r.status, 409);
    assert.equal(stripeCalls.length, 0, "no Stripe call before the bill is filed");

    await call("/api/jobs/GMM-0042", { method: "PUT",
      body: { ...job, updatedAt: "2026-10-16T18:05:00.000Z" } });

    // The request body's amount is ignored; the filed invoice is the bill.
    r = await call("/api/jobs/GMM-0042/payment-link", { method: "POST", body: { totalCents: 1 } });
    assert.equal(r.status, 200);
    const link = await r.json();
    const expectedFee = Math.floor(48750 * 0.03); // the cap binds at this size
    assert.deepEqual(
      { url: link.url, invoiceCents: link.invoiceCents, feeCents: link.feeCents, totalCents: link.totalCents, reused: link.reused },
      { url: "https://buy.stripe.com/test_1", invoiceCents: 48750, feeCents: expectedFee, totalCents: 48750 + expectedFee, reused: false }
    );

    const customer = stripeCalls.find((c) => c.path === "/v1/customers" && c.method === "POST");
    assert.equal(customer.form.get("name"), "Josh Example");
    assert.equal(customer.form.get("email"), "josh@example.com");
    assert.equal(customer.form.get("phone"), "(406) 555-0101");
    const prices = stripeCalls.filter((c) => c.path === "/v1/prices").map((c) => Number(c.form.get("unit_amount")));
    assert.deepEqual(prices, [48750, expectedFee]);
    const created = stripeCalls.find((c) => c.path === "/v1/payment_links");
    assert.equal(created.form.get("line_items[1][price]"), `price_${expectedFee}`);
    assert.equal(created.form.get("payment_method_types[0]"), "card");
    assert.equal(created.form.get("restrictions[completed_sessions][limit]"), "1");
    assert.equal(created.form.get("metadata[gmm_invoice]"), "GMM-INV-0042");
    assert.ok(stripeCalls.filter((c) => c.method === "POST").every((c) => c.key), "every Stripe write is idempotent");
    assert.ok(stripeCalls.every((c) => c.auth === "Bearer rk_test_fake"));

    // Double tap: the same link back, and Stripe is not touched again.
    const before = stripeCalls.length;
    r = await call("/api/jobs/GMM-0042/payment-link", { method: "POST", body: {} });
    const again = await r.json();
    assert.equal(again.url, link.url);
    assert.equal(again.reused, true);
    assert.equal(stripeCalls.length, before);

    // Reopened and refiled at a new total: a new link, and the old one is shut off.
    await call("/api/jobs/GMM-0042", { method: "PUT", body: { ...job,
      invoice: { ...job.invoice, totalCents: 52000 }, updatedAt: "2026-10-16T19:00:00.000Z" } });
    r = await call("/api/jobs/GMM-0042/payment-link", { method: "POST", body: {} });
    const refiled = await r.json();
    assert.equal(refiled.url, "https://buy.stripe.com/test_2");
    assert.equal(refiled.invoiceCents, 52000);
    const deactivate = stripeCalls.find((c) => c.path === "/v1/payment_links/plink_1");
    assert.equal(deactivate?.form.get("active"), "false");
    const rows = env.DB._raw.prepare("SELECT id, active FROM stripe_payment_links ORDER BY created_at").all();
    assert.deepEqual(rows.map((row) => [row.id, row.active]), [["plink_1", 0], ["plink_2", 1]]);

    // Refiled BACK to the first total: must be a fresh link, not a replay of
    // the switched-off one.
    await call("/api/jobs/GMM-0042", { method: "PUT", body: { ...job, updatedAt: "2026-10-16T20:00:00.000Z" } });
    r = await call("/api/jobs/GMM-0042/payment-link", { method: "POST", body: {} });
    const back = await r.json();
    assert.equal(back.url, "https://buy.stripe.com/test_3");
    const keys = stripeCalls.filter((c) => c.path === "/v1/payment_links").map((c) => c.key);
    assert.equal(new Set(keys).size, keys.length, "no two links share an idempotency key");

    // Health reports the key is configured.
    r = await call("/api/health");
    assert.equal((await r.json()).cardPayments, true);
  } finally {
    globalThis.fetch = realFetch;
  }
});
