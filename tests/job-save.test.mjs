/**
 * Drives docs/app.js exactly as shipped, inside the real docs/index.html, in a
 * real DOM: a new customer is typed into the real form and the real Save
 * button is tapped.
 *
 * This exists because of a defect that made the app look like it was deleting
 * customers. `flushSyncQueue` installed its in-flight lock AFTER the async body
 * ran, and an empty queue drains without ever awaiting — so the first sync at
 * boot cleared the lock in its own `finally` before the assignment installed
 * it, leaving a permanently settled promise. Every later flush returned that
 * promise instantly and uploaded nothing. The job stayed in this phone's
 * storage and never reached the cloud, so it survived right up until Safari
 * evicted the site data.
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

function boot({ store, cloud, calls }) {
  const { window: dom } = parseHTML(readFileSync(`${DOCS}/index.html`, "utf8"));

  // linkedom ships neither form.reset, dialog.showModal, nor a form-backed
  // FormData, so the three the app actually uses are supplied here.
  const form = dom.document.getElementById("jobForm");
  Object.getPrototypeOf(form).reset = function reset() {
    this.querySelectorAll("input, textarea, select").forEach((el) => { el.value = ""; });
  };
  for (const dialog of dom.document.querySelectorAll("dialog")) {
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
    document: dom.document, confirm: () => true, alert: () => {},
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
  context.location = { hash: "", origin: "https://thomasg42.github.io", pathname: "/gmm/index.html" };
  context.addEventListener = () => {};
  context.scrollTo = () => {};
  context.matchMedia = () => ({ matches: false, addEventListener() {} });

  vm.createContext(context);
  vm.runInContext(readFileSync(`${DOCS}/app.js`, "utf8"), context, { filename: "app.js" });
  return { dom, context };
}

const settle = async (until) => {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    await new Promise((r) => setTimeout(r, 5));
    if (!until || until()) return;
  }
  if (until) throw new Error("timed out waiting for the app to settle");
};

test("a new customer is saved on the phone and reaches the cloud", { skip: parseHTML ? false : "linkedom is not installed" }, async () => {
  const store = new Map();
  const cloud = new Map();
  const calls = [];

  const { dom } = boot({ store, cloud, calls });
  await settle(() => calls.some((c) => c.url.endsWith("/api/jobs")));
  const doc = dom.document;
  const state = () => JSON.parse(store.get("gold-mobile-mechanic-phone-v1") || '{"jobs":[]}');
  const pendingJobs = () => JSON.parse(store.get("gold-mobile-mechanic-pending-jobs-v1") || "[]");
  const fill = (name, value) => {
    const field = doc.querySelector(`#jobForm [name="${name}"]`);
    assert.ok(field, `the form still has a ${name} field`);
    field.value = value;
  };

  doc.getElementById("newJobButton").dispatchEvent(new dom.Event("click"));
  await settle(() => doc.getElementById("jobDialog").open);

  // ------------------------------------------------- the Save button exists
  const saveJobButton = doc.getElementById("saveJobButton");
  assert.ok(saveJobButton, "the New Job sheet has a Save button");
  assert.equal(saveJobButton.getAttribute("type"), "submit");
  assert.ok(doc.getElementById("saveAllButton"), "the top bar has a Save button");

  // ------------------------------------- a missing field is named, not silent
  fill("customerName", "Jane Rivera");
  doc.getElementById("jobForm").dispatchEvent(new dom.Event("submit"));
  await settle(() => !doc.getElementById("jobFormError").classList.contains("hidden"));
  const error = doc.getElementById("jobFormError").textContent;
  assert.match(error, /vehicle make/);
  assert.match(error, /labor rate/);
  assert.equal(state().jobs.length, 0, "an incomplete form creates no job");
  // The typing is not thrown away while the missing fields are filled in.
  assert.match(store.get("gold-mobile-mechanic-new-job-draft-v1"), /Jane Rivera/);

  // ------------------------------------------------------- a complete save
  fill("customerPhone", "406 555 0101");
  fill("vehicleYear", "2014");
  fill("vehicleMake", "Chevrolet");
  fill("vehicleModel", "Cruze");
  fill("agreedWork", "Oil filter housing");
  fill("laborRate", "125");
  // linkedom has no implicit submission, so the form is submitted directly.
  // That Save reaches this same handler is covered by its type="submit" above.
  doc.getElementById("jobForm").dispatchEvent(new dom.Event("submit"));
  await settle(() => state().jobs.length === 1);

  const saved = state().jobs[0];
  assert.equal(saved.customerName, "Jane Rivera");
  assert.equal(saved.status, "draft");

  // THE REGRESSION: the job body must actually leave the phone.
  await settle(() => cloud.has(saved.id));
  assert.ok(cloud.has(saved.id), "the new customer reached the cloud ledger");
  assert.equal(cloud.get(saved.id).customerName, "Jane Rivera");
  assert.deepEqual(pendingJobs(), [], "nothing is left stuck in the upload queue");

  // The confirmation names the customer, not just an opaque job id.
  assert.match(doc.getElementById("toast").textContent, /Jane Rivera/);

  // ------------------------------------------ clocking in keeps it, and syncs
  const timerButton = doc.querySelector("[data-timer-action]");
  assert.equal(timerButton.dataset.timerAction, "clock_in");
  timerButton.dispatchEvent(new dom.Event("click"));
  await settle(() => state().jobs[0].status === "in_progress");
  await settle(() => cloud.get(saved.id)?.status === "in_progress");

  assert.equal(cloud.get(saved.id).status, "in_progress", "the clock in reached the cloud too");
  assert.equal(state().jobs.length, 1, "clocking in did not lose the customer");

  // --------------------------------------------------------- and a reload
  const reloaded = boot({ store, cloud, calls });
  await settle(() => reloaded.dom.document.getElementById("jobGrid").innerHTML.includes("Jane Rivera"));
  assert.equal(state().jobs.length, 1);
  assert.equal(state().jobs[0].customerName, "Jane Rivera");
});

test("the top-bar Save button drains the queue and reports the truth", { skip: parseHTML ? false : "linkedom is not installed" }, async () => {
  const store = new Map();
  const cloud = new Map();
  const calls = [];

  // A job left stranded in the upload queue by an earlier offline session.
  store.set("gold-mobile-mechanic-phone-v1", JSON.stringify({
    version: 1,
    jobs: [{
      id: "GMM-0002", customerName: "Marcus Bell", customerPhone: "", customerEmail: "",
      vehicleYear: "2018", vehicleMake: "Ford", vehicleModel: "F-150", laborRateCents: 12500,
      status: "draft", materials: [], receipts: [], timeEntries: [], eventHistory: [],
      agreedWork: "Brake service", createdAt: "2026-08-25T14:00:00.000Z",
      updatedAt: "2026-08-25T14:00:00.000Z"
    }]
  }));
  store.set("gold-mobile-mechanic-pending-jobs-v1", JSON.stringify(["GMM-0002"]));

  const { dom } = boot({ store, cloud, calls });
  await settle(() => cloud.has("GMM-0002"));

  // Boot alone recovers it now; the button must also work on demand.
  cloud.clear();
  store.set("gold-mobile-mechanic-pending-jobs-v1", JSON.stringify(["GMM-0002"]));
  dom.document.getElementById("saveAllButton").dispatchEvent(new dom.Event("click"));
  await settle(() => cloud.has("GMM-0002"));

  assert.equal(cloud.get("GMM-0002").customerName, "Marcus Bell");
  assert.match(dom.document.getElementById("toast").textContent, /Everything saved/);
});
