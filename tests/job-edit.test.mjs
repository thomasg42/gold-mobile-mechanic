/**
 * Drives docs/app.js as shipped, in a real DOM: an existing work order is
 * opened and corrected the way a thumb corrects it.
 *
 * Two things are pinned here.
 *
 * 1. EVERY FIELD IS CORRECTABLE. A name heard wrong over a phone, a caller's
 *    number a digit short, a plate that was never read, the agreed scope — all
 *    of it was write-once at creation and could only be fixed by starting the
 *    job over. Each card now carries an Edit button and its own editor.
 *
 * 2. THE SHORT-CIRCUIT. `flushJobAutosave` chained its persist* calls with
 *    `||`, so the first panel that reported a change stopped the rest from
 *    being asked at all. Editing the suggestions and the hourly rate in one
 *    visit saved the suggestions and silently discarded the rate on the next
 *    render.
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

const SEED = {
  version: 1,
  jobs: [{
    id: "GMM-0007",
    customerName: "Jon Macray",
    customerPhone: "406 555 0101",
    customerEmail: "",
    vehicleYear: "2014",
    vehicleMake: "Chevrolet",
    vehicleModel: "Cruze",
    vehiclePlate: "",
    laborRateCents: 12000,
    status: "in_progress",
    materials: [],
    receipts: [],
    timeEntries: [{ startedAt: "2026-08-25T14:00:00.000Z", endedAt: "2026-08-25T15:00:00.000Z" }],
    eventHistory: [],
    agreedWork: "Oil filter housing",
    suggestions: "",
    startedAt: "2026-08-25T14:00:00.000Z",
    createdAt: "2026-08-25T14:00:00.000Z",
    updatedAt: "2026-08-25T14:00:00.000Z"
  }]
};

function boot({ store, cloud, calls }) {
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
    navigator: { onLine: true },
    Headers: globalThis.Headers, Request: globalThis.Request, Response: globalThis.Response,
    Blob: globalThis.Blob, FormData: ShimFormData, URL: globalThis.URL,
    Event: dom.Event, CustomEvent: dom.CustomEvent, Image: class {},
    document: doc, confirm: () => true, alert: () => {},
    fetch: async (url, options = {}) => {
      const address = String(url);
      const method = options.method || "GET";
      calls.push({ url: address, method });
      if (address.endsWith("/api/jobs") && method === "GET") {
        return new Response(JSON.stringify({ jobs: [...cloud.values()] }), { status: 200 });
      }
      if (/\/api\/jobs\/[^/]+$/.test(address) && method === "PUT") {
        const job = JSON.parse(options.body);
        cloud.set(job.id, job);
        return new Response(JSON.stringify({ job }), { status: 200 });
      }
      return new Response(JSON.stringify({ recorded: true }), { status: 200 });
    }
  };
  context.window = context;
  context.self = context;
  context.location = { hash: "#job/GMM-0007", origin: "https://thomasg42.github.io", pathname: "/gmm/index.html" };
  context.addEventListener = () => {};
  context.scrollTo = () => {};
  context.matchMedia = () => ({ matches: false, addEventListener() {} });

  vm.createContext(context);
  vm.runInContext(readFileSync(`${DOCS}/app.js`, "utf8"), context, { filename: "app.js" });
  return { dom, context };
}

const settle = async (until, label = "the app") => {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    await new Promise((r) => setTimeout(r, 5));
    if (until()) return;
  }
  throw new Error(`timed out waiting for ${label}`);
};

test("every line of a work order can be corrected after the fact", { skip: parseHTML ? false : "linkedom is not installed" }, async () => {
  const store = new Map([["gold-mobile-mechanic-phone-v1", JSON.stringify(SEED)]]);
  const cloud = new Map();
  const calls = [];

  const { dom } = boot({ store, cloud, calls });
  const doc = dom.document;
  const state = () => JSON.parse(store.get("gold-mobile-mechanic-phone-v1")).jobs[0];

  await settle(() => doc.getElementById("jobDetailsCard"), "the work order to open");

  // ------------------------------------------- there is an Edit button on it
  const toggle = doc.querySelector('[data-edit-toggle="jobDetailsCard"]');
  assert.ok(toggle, "the customer and vehicle card has an Edit button");
  assert.equal(toggle.textContent.trim(), "Edit");
  assert.ok(
    doc.getElementById("jobDetailsCard").textContent.includes("Jon Macray"),
    "the read view shows the record before it is edited"
  );

  toggle.dispatchEvent(new dom.Event("click"));
  assert.ok(doc.getElementById("jobDetailsCard").classList.contains("is-editing"));
  assert.equal(toggle.textContent.trim(), "Done");

  // --------------------------------- the name, the caller, the plate, the mail
  const field = (name) => doc.querySelector(`[data-job-field="${name}"]`);
  for (const name of ["customerName", "customerPhone", "customerEmail", "vehicleYear", "vehicleMake", "vehicleModel", "vehiclePlate"]) {
    assert.ok(field(name), `${name} is editable on the work order`);
  }
  assert.equal(field("customerName").value, "Jon Macray", "the editor opens on the saved value");

  field("customerName").value = "Jon McCrae";
  field("customerPhone").value = "406 555 0199";
  field("customerEmail").value = "jon@example.com";
  field("vehiclePlate").value = "8b 1234x";
  doc.getElementById("saveDetailsButton").dispatchEvent(new dom.Event("click"));

  await settle(() => state().customerName === "Jon McCrae", "the corrected name to save");
  assert.equal(state().customerPhone, "406 555 0199");
  assert.equal(state().customerEmail, "jon@example.com");
  assert.equal(state().vehiclePlate, "8B 1234X", "a plate is stored the way a plate reads");

  // It has to leave the phone, not just sit in localStorage.
  await settle(() => cloud.get("GMM-0007")?.customerName === "Jon McCrae", "the correction to reach the cloud");

  // ...and the read view has to catch up, or the record looks unchanged.
  await settle(
    () => doc.getElementById("jobDetailsCard").textContent.includes("Jon McCrae"),
    "the read view to re-render"
  );

  // ------------------------------------------------ a blank name is not a wipe
  doc.querySelector('[data-edit-toggle="jobDetailsCard"]').dispatchEvent(new dom.Event("click"));
  field("customerName").value = "   ";
  doc.getElementById("saveDetailsButton").dispatchEvent(new dom.Event("click"));
  await settle(() => true);
  assert.equal(state().customerName, "Jon McCrae", "clearing the name does not erase the customer");

  // ------------------------------------------------------------ agreed work
  const workToggle = doc.querySelector('[data-edit-toggle="agreedWorkCard"]');
  assert.ok(workToggle, "the agreed work card has an Edit button");
  workToggle.dispatchEvent(new dom.Event("click"));
  const workInput = doc.getElementById("agreedWorkInput");
  assert.ok(workInput, "the agreed scope is editable");
  workInput.value = "Oil filter housing, thermostat, coolant flush";
  doc.getElementById("saveAgreedWorkButton").dispatchEvent(new dom.Event("click"));
  await settle(() => state().agreedWork.includes("coolant"), "the agreed work to save");
  await settle(() => cloud.get("GMM-0007")?.agreedWork.includes("coolant"), "agreed work to reach the cloud");
});

test("editing two panels in one visit saves both", { skip: parseHTML ? false : "linkedom is not installed" }, async () => {
  const store = new Map([["gold-mobile-mechanic-phone-v1", JSON.stringify(SEED)]]);
  const cloud = new Map();
  const calls = [];

  const { dom } = boot({ store, cloud, calls });
  const doc = dom.document;
  const state = () => JSON.parse(store.get("gold-mobile-mechanic-phone-v1")).jobs[0];

  await settle(() => doc.getElementById("suggestionsInput"), "the work order to open");

  // THE REGRESSION: `||` between the persist* calls meant the first panel that
  // reported a change stopped every later one from being asked at all.
  doc.getElementById("suggestionsInput").value = "Front pads are near minimum thickness.";
  doc.getElementById("laborRateInput").value = "145.00";

  // One blur, the way leaving the card actually saves it.
  doc.getElementById("jobView").dispatchEvent(new dom.Event("focusout"));

  await settle(() => state().suggestions.startsWith("Front pads"), "the suggestions to save");
  assert.equal(state().laborRateCents, 14500, "the hourly rate typed in the same visit is saved too");
  await settle(() => cloud.get("GMM-0007")?.laborRateCents === 14500, "the new rate to reach the cloud");
});
