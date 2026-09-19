/**
 * Drives docs/app.js as shipped, in a real DOM, for the "Every customer, every
 * job" board: the same ledger folded by person instead of by work order.
 *
 * WHY THIS IS A VIEW AND NOT A DATA MIGRATION. The live table is
 * `jobs(id, data, updated_at)` — one JSON blob per work order. There is no
 * customers table and never was, so "the same person has three separate
 * entries" is not duplicate rows to merge; it is three jobs that each carry
 * their own copy of a name and a number. Grouping is therefore derived at
 * render time and nothing is written, merged or deleted.
 *
 * Thomas's rule, verbatim: "if the name is somewhat similar and/or the phone
 * number is the same, put those invoices together because it is obviously the
 * same person." What is pinned here:
 *
 * 1. THE TWO HE NAMED. Klaver owns the 2008 Honda; Josh Berg owns the 2016
 *    Silverado — one card each, every job under it.
 * 2. A SHARED SURNAME IS NOT A PERSON. Jane Smith and John Smith stay apart,
 *    which is the one thing an eager matcher gets wrong and cannot be seen
 *    from a happy-path screenshot.
 * 3. A NAME-ONLY JOIN THAT SWALLOWS TWO DIFFERENT NUMBERS IS FLAGGED, not
 *    presented as fact.
 * 4. THE JOB LIST IS STILL THE DEFAULT. Nothing was put between his thumb and
 *    a clock-in.
 *
 * Needs `linkedom`; the test is skipped with a clear message when it is absent.
 */
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import vm from "node:vm";
import test from "node:test";
import { fileURLToPath } from "node:url";

const DOCS = fileURLToPath(new URL("../docs/", import.meta.url)).replace(/\/$/, "");
let parseHTML;
try {
  ({ parseHTML } = await import("linkedom"));
} catch {
  parseHTML = null;
}

const job = (fields) => ({
  customerEmail: "",
  vehiclePlate: "",
  laborRateCents: 12000,
  status: "completed",
  materials: [],
  receipts: [],
  timeEntries: [],
  eventHistory: [],
  agreedWork: "",
  suggestions: "",
  archived: false,
  ...fields,
  updatedAt: fields.createdAt
});

const SEED = {
  version: 1,
  jobs: [
    // --- the two Thomas named ------------------------------------------------
    // Klaver, entered three ways across three visits. Only the first carries a
    // number; the other two are a surname and a typo.
    job({
      id: "GMM-0101", customerName: "Mike Klaver", customerPhone: "(406) 555-0188",
      vehicleYear: "2008", vehicleMake: "Honda", vehicleModel: "Accord",
      createdAt: "2026-03-02T15:00:00.000Z"
    }),
    job({
      id: "GMM-0102", customerName: "Klaver", customerPhone: "",
      vehicleYear: "2008", vehicleMake: "Honda", vehicleModel: "Accord",
      createdAt: "2026-05-11T15:00:00.000Z"
    }),
    job({
      id: "GMM-0103", customerName: "Mike Claver", customerPhone: "4065550188",
      vehicleYear: "2008", vehicleMake: "Honda", vehicleModel: "Accord",
      createdAt: "2026-07-19T15:00:00.000Z"
    }),
    // Josh Berg — second visit logged first-name-only, same number reformatted.
    job({
      id: "GMM-0104", customerName: "Josh Berg", customerPhone: "406-555-0142",
      vehicleYear: "2016", vehicleMake: "Chevrolet", vehicleModel: "Silverado",
      createdAt: "2026-04-08T15:00:00.000Z"
    }),
    job({
      id: "GMM-0105", customerName: "Josh", customerPhone: "1 (406) 555 0142",
      vehicleYear: "2016", vehicleMake: "Chevrolet", vehicleModel: "Silverado",
      createdAt: "2026-08-21T15:00:00.000Z"
    }),
    // --- two different people who share a surname ----------------------------
    job({
      id: "GMM-0106", customerName: "Jane Smith", customerPhone: "406 555 0111",
      vehicleYear: "2019", vehicleMake: "Subaru", vehicleModel: "Outback",
      createdAt: "2026-06-01T15:00:00.000Z"
    }),
    job({
      id: "GMM-0107", customerName: "John Smith", customerPhone: "406 555 0222",
      vehicleYear: "2012", vehicleMake: "Ford", vehicleModel: "F-150",
      createdAt: "2026-06-02T15:00:00.000Z"
    }),
    // --- one name, two numbers: grouped per his rule, but flagged ------------
    job({
      id: "GMM-0108", customerName: "Dale Rivers", customerPhone: "406 555 0333",
      vehicleYear: "2003", vehicleMake: "Toyota", vehicleModel: "Tacoma",
      createdAt: "2026-06-10T15:00:00.000Z"
    }),
    job({
      id: "GMM-0109", customerName: "Dale Rivers", customerPhone: "406 555 0444",
      vehicleYear: "2021", vehicleMake: "Ram", vehicleModel: "1500",
      createdAt: "2026-06-12T15:00:00.000Z"
    }),
    // --- a bare first name must not bridge two unrelated people -------------
    // "Josh" on a different truck with a different number is a different Josh.
    job({
      id: "GMM-0111", customerName: "Josh", customerPhone: "406 555 0999",
      vehicleYear: "1998", vehicleMake: "Jeep", vehicleModel: "Cherokee",
      createdAt: "2026-06-20T15:00:00.000Z"
    }),
    // --- archived work stays out of the customer board -----------------------
    job({
      id: "GMM-0110", customerName: "Mike Klaver", customerPhone: "(406) 555-0188",
      vehicleYear: "2008", vehicleMake: "Honda", vehicleModel: "Accord",
      archived: true, createdAt: "2026-02-01T15:00:00.000Z"
    })
  ]
};

function boot({ store }) {
  const { window: dom } = parseHTML(readFileSync(`${DOCS}/index.html`, "utf8"));
  const doc = dom.document;

  const form = doc.getElementById("jobForm");
  Object.getPrototypeOf(form).reset = function reset() {
    this.querySelectorAll("input, textarea, select").forEach((el) => { el.value = ""; });
  };
  for (const dialog of doc.querySelectorAll("dialog")) {
    dialog.showModal = function showModal() { this.setAttribute("open", ""); this.open = true; };
    dialog.close = function close() { this.removeAttribute("open"); this.open = false; };
  }
  class ShimFormData {
    constructor(source) {
      this.values = new Map();
      if (source) {
        source.querySelectorAll("input, textarea, select").forEach((el) => {
          const name = el.getAttribute("name");
          if (name && !this.values.has(name)) this.values.set(name, el.value ?? "");
        });
      }
    }
    get(key) { return this.values.has(key) ? this.values.get(key) : null; }
    set(key, value) { this.values.set(key, value); }
  }

  const context = {
    console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval, queueMicrotask,
    crypto: { randomUUID: () => `id-${Math.random().toString(36).slice(2, 12)}` },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k)
    },
    indexedDB: { open: () => ({ set onerror(_f) {}, set onsuccess(_f) {}, set onupgradeneeded(_f) {} }) },
    navigator: { onLine: false },
    Headers: globalThis.Headers, Request: globalThis.Request, Response: globalThis.Response,
    Blob: globalThis.Blob, FormData: ShimFormData, URL: globalThis.URL,
    Event: dom.Event, CustomEvent: dom.CustomEvent, Image: class {},
    document: doc, confirm: () => true, alert: () => {},
    fetch: async () => new Response(JSON.stringify({ jobs: [] }), { status: 200 })
  };
  context.window = context;
  context.self = context;
  context.location = { hash: "", origin: "https://thomasg42.github.io", pathname: "/gmm/index.html" };
  context.addEventListener = () => {};
  context.scrollTo = () => {};
  context.matchMedia = () => ({ matches: false, addEventListener() {} });

  vm.createContext(context);
  for (const file of ["sync-auth.js", "app.js"]) {
    vm.runInContext(readFileSync(`${DOCS}/${file}`, "utf8"), context, { filename: file });
  }
  return { dom, context };
}

const settle = async (until, label = "the app") => {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    await new Promise((r) => setTimeout(r, 5));
    if (until()) return;
  }
  throw new Error(`timed out waiting for ${label}`);
};

const cardFor = (doc, name) => [...doc.querySelectorAll(".customer-card")]
  .find((card) => card.querySelector("h3")?.textContent.trim() === name);

test("the ledger folds into one card per person", { skip: parseHTML ? false : "linkedom is not installed" }, async () => {
  const store = new Map([["gold-mobile-mechanic-phone-v1", JSON.stringify(SEED)]]);
  const { dom } = boot({ store });
  const doc = dom.document;

  await settle(() => doc.querySelectorAll(".job-card").length > 0, "the job board");

  // --------------------------------------------- the job list is the default
  assert.equal(doc.getElementById("jobGrid").classList.contains("hidden"), false,
    "the job list is what he lands on");
  assert.equal(doc.getElementById("customerGrid").classList.contains("hidden"), true,
    "the customer board is the second view, not the first");
  assert.equal(doc.getElementById("boardModeJobs").getAttribute("aria-pressed"), "true");

  doc.getElementById("boardModeCustomers").dispatchEvent(new dom.Event("click", { bubbles: true }));
  await settle(() => doc.querySelectorAll(".customer-card").length > 0, "the customer board");

  assert.equal(doc.getElementById("jobGrid").classList.contains("hidden"), true);
  assert.equal(doc.getElementById("customerGrid").classList.contains("hidden"), false);

  // ----------------------------------------------------- Klaver, 2008 Honda
  const klaverCards = [...doc.querySelectorAll(".customer-card")]
    .filter((card) => /klaver|claver/i.test(card.querySelector("h3").textContent));
  assert.equal(klaverCards.length, 1,
    "Klaver is one customer, not three — surname-only and a typo fold in");

  const klaver = klaverCards[0];
  assert.equal(klaver.querySelector("h3").textContent.trim(), "Mike Klaver",
    "the fullest, most-used, earliest spelling wins the card over the later typo");
  assert.match(klaver.querySelector(".customer-aliases").textContent, /Mike Claver/,
    "and the spellings that lost are shown, so the tiebreak carries no weight");
  const klaverJobs = [...klaver.querySelectorAll(".customer-job")].map((b) => b.dataset.jobId);
  assert.deepEqual(klaverJobs, ["GMM-0103", "GMM-0102", "GMM-0101"],
    "all three visits sit under him, newest first");
  assert.match(klaver.textContent, /2008 Honda Accord/, "and the 2008 Honda is his");
  assert.equal(klaver.querySelector(".customer-review"), null,
    "one number across the group, so there is nothing to second-guess");

  // ------------------------------------------------ Josh Berg, 2016 Silverado
  const berg = cardFor(doc, "Josh Berg");
  assert.ok(berg, "Josh Berg is one customer");
  assert.deepEqual(
    [...berg.querySelectorAll(".customer-job")].map((b) => b.dataset.jobId),
    ["GMM-0105", "GMM-0104"],
    "the first-name-only visit joins on the phone number alone"
  );
  assert.match(berg.textContent, /2016 Chevrolet Silverado/);
  assert.equal(berg.querySelector(".customer-phones").textContent.trim(), "1 (406) 555 0142",
    "one number, once — the same phone typed two ways is not two contacts");
  assert.equal(klaver.querySelector(".customer-phones").textContent.trim(), "(406) 555-0188",
    "and the readable spelling is the one left on screen");

  // --------------------------------- a shared surname is not the same person
  assert.ok(cardFor(doc, "Jane Smith"), "Jane Smith keeps her own card");
  assert.ok(cardFor(doc, "John Smith"), "John Smith keeps his");

  // ------------------------- one name, two numbers: grouped, but not asserted
  const rivers = cardFor(doc, "Dale Rivers");
  assert.ok(rivers, "the two Dale Rivers jobs are grouped, per his rule");
  assert.equal(rivers.querySelectorAll(".customer-job").length, 2);
  assert.ok(rivers.querySelector(".customer-review"),
    "but two different numbers under one name is flagged for him to settle");

  // -------------------------------------- archived work stays off this board
  assert.equal(doc.querySelector('#customerGrid [data-job-id="GMM-0110"]'), null,
    "an archived job does not resurface here");
  // ------------------- a bare first name does not swallow an unrelated person
  const bergJobs = [...berg.querySelectorAll(".customer-job")].map((b) => b.dataset.jobId);
  assert.equal(bergJobs.includes("GMM-0111"), false,
    "the other Josh — different truck, different number — is not Josh Berg");
  const otherJosh = doc.querySelector('#customerGrid [data-job-id="GMM-0111"]')
    ?.closest(".customer-card");
  assert.ok(otherJosh, "he still gets a card of his own");
  assert.equal(otherJosh.querySelectorAll(".customer-job").length, 1);

  assert.equal(doc.querySelectorAll(".customer-card").length, 6,
    "six people across eleven work orders");

  // ------------------------------------------ a job on the card still opens
  doc.querySelector('#customerGrid [data-job-id="GMM-0104"]')
    .dispatchEvent(new dom.Event("click", { bubbles: true }));
  await settle(() => !doc.getElementById("jobView").classList.contains("hidden"), "the work order");
  assert.match(doc.getElementById("jobView").textContent, /Josh Berg/,
    "tapping a job from the customer card opens that work order");
});

test("grouping never rewrites the ledger", { skip: parseHTML ? false : "linkedom is not installed" }, async () => {
  const store = new Map([["gold-mobile-mechanic-phone-v1", JSON.stringify(SEED)]]);
  const { dom } = boot({ store });
  const doc = dom.document;
  await settle(() => doc.querySelectorAll(".job-card").length > 0, "the job board");

  doc.getElementById("boardModeCustomers").dispatchEvent(new dom.Event("click", { bubbles: true }));
  await settle(() => doc.querySelectorAll(".customer-card").length > 0, "the customer board");

  // The whole safety argument for this feature in one assertion: ten work
  // orders in, ten work orders out, each with the name and number it was
  // saved with. Nothing was merged away.
  const saved = JSON.parse(store.get("gold-mobile-mechanic-phone-v1")).jobs;
  assert.equal(saved.length, SEED.jobs.length, "no job was consumed by a merge");
  for (const original of SEED.jobs) {
    const now = saved.find((entry) => entry.id === original.id);
    assert.ok(now, `${original.id} survived`);
    assert.equal(now.customerName, original.customerName, `${original.id} kept its name`);
    assert.equal(now.customerPhone, original.customerPhone, `${original.id} kept its number`);
  }
});
