/**
 * Drives docs/app.js as shipped, in a real DOM.
 *
 * Two things are pinned here.
 *
 * 1. UNSUBMIT INVOICE. A filed invoice is not the end of the road. "Unsubmit
 *    invoice" reopens the job clocked out, withdraws the filed invoice (so it
 *    leaves the customer portal), and unlocks every field again. Billable time,
 *    intervals and the clock ledger are left untouched.
 *
 * 2. THE CUSTOMER'S OWN LINK. The filed-invoice card shows a permanent portal
 *    link for that one customer, built from the same name+phone hash the worker
 *    uses (sync-worker/index.ts customerKey). The email draft carries it too.
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

// Independent re-implementation of sync-worker/index.ts customerKey, so the
// phone's copy is checked against a second implementation rather than itself.
function expectedCustomerId(name, phone) {
  const normalizedName = String(name ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  let digits = String(phone ?? "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  let hash = 0x811c9dc5;
  for (const character of `${normalizedName}|${digits}`) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, "0");
}

const INVOICED_JOB = {
  id: "GMM-20260825-0007",
  customerName: "Jon Macray",
  customerPhone: "(406) 555-0101",
  customerEmail: "jon@example.com",
  vehicleYear: "2014",
  vehicleMake: "Chevrolet",
  vehicleModel: "Cruze",
  vehiclePlate: "8B1234X",
  laborRateCents: 12000,
  laborAmountCents: null,
  status: "invoiced",
  receiptReview: true,
  materials: [],
  receipts: [],
  timeEntries: [{ id: "t1", kind: "work", startedAt: "2026-08-25T14:00:00.000Z", endedAt: "2026-08-25T15:00:00.000Z" }],
  eventHistory: [
    { id: "e1", action: "clock_in", occurredAt: "2026-08-25T14:00:00.000Z" },
    { id: "e2", action: "clock_out", occurredAt: "2026-08-25T15:00:00.000Z" },
    { id: "e3", action: "finished", occurredAt: "2026-08-25T15:01:00.000Z" }
  ],
  agreedWork: "Oil filter housing",
  suggestions: "Rear pads soon",
  difficultyLevel: "Standard",
  startedAt: "2026-08-25T14:00:00.000Z",
  endedAt: "2026-08-25T15:01:00.000Z",
  createdAt: "2026-08-25T14:00:00.000Z",
  updatedAt: "2026-08-25T15:01:00.000Z",
  invoice: {
    invoiceNumber: "GMM-INV-20260825-0007",
    createdAt: "2026-08-25T15:01:00.000Z",
    updatedAt: "2026-08-25T15:01:00.000Z",
    workSeconds: 3600,
    laborCents: 12000,
    materialsCents: 0,
    totalCents: 12000
  }
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

  const context = {
    console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval, queueMicrotask,
    crypto: { randomUUID: () => `id-${Math.random().toString(36).slice(2, 12)}` },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k)
    },
    indexedDB: { open: () => ({ set onerror(_f) {}, set onsuccess(_f) {}, set onupgradeneeded(_f) {} }) },
    navigator: { onLine: true, clipboard: { writeText: async () => {} } },
    Headers: globalThis.Headers, Request: globalThis.Request, Response: globalThis.Response,
    Blob: globalThis.Blob, URL: globalThis.URL,
    Event: dom.Event, CustomEvent: dom.CustomEvent, Image: class {},
    document: doc, confirm: () => true, alert: () => {}, prompt: () => "",
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
  context.location = { hash: `#job/${INVOICED_JOB.id}`, origin: "https://thomasg42.github.io", pathname: "/gold-mobile-mechanic/index.html" };
  context.addEventListener = () => {};
  context.scrollTo = () => {};
  context.matchMedia = () => ({ matches: false, addEventListener() {} });

  vm.createContext(context);
  // sync-auth.js first: app.js calls through it for every cloud request.
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

test("a filed invoice can be unsubmitted, and it carries the customer's own link", { skip: parseHTML ? false : "linkedom is not installed" }, async () => {
  const store = new Map([["gmm-sync-token", "test-device.signature"], ["gold-mobile-mechanic-phone-v1", JSON.stringify({ version: 1, jobs: [INVOICED_JOB] })]]);
  const cloud = new Map([[INVOICED_JOB.id, structuredClone(INVOICED_JOB)]]);
  const calls = [];

  const { dom } = boot({ store, cloud, calls });
  const doc = dom.document;
  const state = () => JSON.parse(store.get("gold-mobile-mechanic-phone-v1")).jobs[0];

  // The filed-invoice card is on screen, with the two unsubmit buttons.
  await settle(() => doc.querySelectorAll("[data-unsubmit-invoice]").length >= 2, "the filed invoice to render");

  // ---------------------------------------------- the customer's own portal link
  const expectedId = expectedCustomerId("Jon Macray", "(406) 555-0101");
  const linkUrl = doc.querySelector(".customer-link-url");
  assert.ok(linkUrl, "the filed invoice shows a customer link");
  assert.match(linkUrl.textContent, new RegExp(`portal\\.html#customer/${expectedId}$`));
  const copyButton = doc.getElementById("copyCustomerLinkButton");
  assert.equal(copyButton.dataset.link, `https://thomasg42.github.io/gold-mobile-mechanic/portal.html#customer/${expectedId}`);

  // ------------------------------------------------------------ unsubmit invoice
  doc.querySelector("[data-unsubmit-invoice]").dispatchEvent(new dom.Event("click"));

  await settle(() => state().status === "clocked_out", "the job to reopen clocked out");
  assert.equal(state().invoice, null, "the filed invoice is withdrawn");
  assert.equal(state().endedAt, null, "the job no longer carries an end date");
  assert.ok(
    state().eventHistory.some((event) => event.action === "invoice_reopened"),
    "an append-only reopen event is recorded"
  );
  assert.ok(
    state().eventHistory.some((event) => event.action === "clock_out" && event.occurredAt > "2026-08-25T15:01:00.000Z"),
    "a fresh clock-out event is written so the cloud merge resolves it clocked out"
  );
  // Billable history is untouched.
  assert.equal(state().timeEntries.length, 1, "the measured interval is left alone");

  // It has to leave the phone.
  await settle(() => cloud.get(INVOICED_JOB.id)?.status === "clocked_out", "the reopen to reach the cloud");
  assert.equal(cloud.get(INVOICED_JOB.id).invoice, null, "the cloud copy drops the invoice too");

  // The page re-renders unlocked: Finish Project is back and enabled.
  await settle(() => {
    const finish = doc.getElementById("clockOutButton");
    return finish && !finish.disabled;
  }, "Finish Project to come back");
});

test("the prepared email carries the customer's own portal link", { skip: parseHTML ? false : "linkedom is not installed" }, async () => {
  const store = new Map([["gmm-sync-token", "test-device.signature"], ["gold-mobile-mechanic-phone-v1", JSON.stringify({ version: 1, jobs: [INVOICED_JOB] })]]);
  const cloud = new Map([[INVOICED_JOB.id, structuredClone(INVOICED_JOB)]]);
  const calls = [];

  const { dom, context } = boot({ store, cloud, calls });
  const doc = dom.document;

  await settle(() => doc.getElementById("emailInvoiceButton"), "the filed invoice to render");

  let mailto = "";
  Object.defineProperty(context.location, "href", { set: (value) => { mailto = value; }, get: () => "", configurable: true });
  doc.getElementById("emailInvoiceButton").dispatchEvent(new dom.Event("click"));

  const expectedId = expectedCustomerId("Jon Macray", "(406) 555-0101");
  assert.match(decodeURIComponent(mailto), new RegExp(`portal\\.html#customer/${expectedId}`));
  assert.doesNotMatch(decodeURIComponent(mailto), /find your name in the list/);
});
