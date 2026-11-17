/**
 * Drives the estimate card in docs/app.js as shipped, in a real DOM: price
 * lines, live totals, autosave, the offline link guard, the customer's answer,
 * converting it onto the invoice, resending, saved jobs, deposits and tax.
 * Harness copied from job-edit.test.mjs. Needs `linkedom`.
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
    crypto: { randomUUID: () => `id-${Math.random().toString(36).slice(2, 12)}`, getRandomValues: (a) => { for (let i = 0; i < a.length; i += 1) a[i] = Math.floor(Math.random() * 256); return a; } },
    btoa: globalThis.btoa, prompt: () => "Front brakes", structuredClone: globalThis.structuredClone,
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


const click = (dom, el) => el.dispatchEvent(new dom.Event("click", { bubbles: true }));
const fire = (dom, el, type) => el.dispatchEvent(new dom.Event(type, { bubbles: true }));
const seedWith = (job) => JSON.stringify({ ...SEED, jobs: [{ ...SEED.jobs[0], ...job }] });

test("estimate card end to end", { skip: parseHTML ? false : "linkedom is not installed" }, async () => {
  const store = new Map([["gmm-sync-token", "test-device.signature"], ["gold-mobile-mechanic-phone-v1", JSON.stringify(SEED)]]);
  const cloud = new Map();
  const calls = [];
  const prompts = [];
  const { dom, context } = boot({ store, cloud, calls });
  context.prompt = (message, value) => { prompts.push({ message, value }); return "Front brakes"; };
  const doc = dom.document;
  const state = () => JSON.parse(store.get("gold-mobile-mechanic-phone-v1")).jobs[0];
  const toast = () => doc.getElementById("toast").textContent;
  const shared = () => prompts.filter((entry) => /Copy this message/.test(entry.message));
  const card = () => doc.getElementById("estimateCard");

  await settle(() => card(), "the estimate card");
  assert.match(card().textContent, /No estimate yet/);
  assert.equal(doc.getElementById("estimateTaxInput"), null, "no tax/supplies inputs before there is a line");

  // ------------------------------------------------------------ price it
  click(dom, doc.querySelector('[data-add-line="labor"]'));
  await settle(() => doc.querySelector("[data-estimate-line]"), "a labor line");
  assert.equal(doc.querySelector('[data-line-field="unitCents"]').value, "120.00", "labor defaults to the job's rate");
  assert.ok(doc.getElementById("estimateTaxInput"), "terms appear with the first line");
  click(dom, doc.querySelector('[data-add-line="part"]'));
  await settle(() => doc.querySelectorAll("[data-estimate-line]").length === 2, "a part line");

  const rows = doc.querySelectorAll("[data-estimate-line]");
  const type = (row, field, value) => {
    const input = row.querySelector(`[data-line-field="${field}"]`);
    input.value = value;
    fire(dom, input, "input");
    return input;
  };
  type(rows[0], "description", "Front brakes"); type(rows[0], "quantity", "2"); type(rows[0], "unitCents", "100");
  type(rows[1], "description", "Pad set"); type(rows[1], "quantity", "1");
  const lastInput = type(rows[1], "unitCents", "60");
  const supplies = doc.getElementById("estimateSuppliesInput");
  supplies.value = "5";
  fire(dom, supplies, "input");

  // Totals follow the keystrokes; nothing is written until change/autosave.
  assert.match(doc.getElementById("estimateTotalsLive").textContent, /\$270\.00/, "2h×$100 + $60 + 5% of labor");
  assert.match(rows[0].textContent, /\$200\.00/, "each line shows its own total");
  assert.equal(state().estimate.lines[0].description, "", "typing alone does not save");

  // Scroll/tap-away autosave commits it, like every other card.
  fire(dom, lastInput, "focusout");
  await settle(() => state().estimate.lines[0].description === "Front brakes", "the estimate to autosave");
  assert.equal(state().estimate.lines[0].unitCents, 10000);
  assert.equal(state().estimate.lines[0].quantity, 2);
  assert.equal(state().estimate.shopSuppliesPct, 5);

  // ------------------------------------------------------------ saved job
  click(dom, doc.getElementById("saveAsJobButton"));
  await settle(() => store.has("gold-mobile-mechanic-saved-jobs-v1"), "the saved job");
  const saved = JSON.parse(store.get("gold-mobile-mechanic-saved-jobs-v1"));
  assert.equal(saved[0].name, "Front brakes");
  assert.equal(saved[0].lines.length, 2);

  // ------------------------------------------- send, offline: link is guarded
  context.navigator.onLine = false;
  click(dom, doc.getElementById("sendEstimateButton"));
  await settle(() => state().estimate?.status === "sent", "the estimate to send");
  const firstToken = state().estimate.token;
  assert.match(firstToken, /^[A-Za-z0-9_-]{22}$/);
  await settle(() => doc.getElementById("shareEstimateButton"), "the share button");
  click(dom, doc.getElementById("shareEstimateButton"));
  await settle(() => /hasn't uploaded yet/.test(toast()), "the offline guard");
  assert.equal(shared().length, 0, "no dead link was handed out");

  context.navigator.onLine = true;
  click(dom, doc.getElementById("shareEstimateButton"));
  await settle(() => shared().length === 1, "the share fallback");
  assert.ok(shared()[0].value.endsWith(`portal.html#estimate/${firstToken}`), "the message carries the link");
  assert.ok(shared()[0].value.startsWith("Hi Jon,"), "first name only");
  assert.equal(cloud.get("GMM-0007").estimate.token, firstToken, "the link is live in the cloud first");
  assert.ok(doc.querySelector(".customer-link-url").textContent.endsWith(`#estimate/${firstToken}`));

  // -------------------------------------------- the customer answers; convert
  const answer = (decisions) => {
    const remote = structuredClone(cloud.get("GMM-0007"));
    remote.estimate = { ...remote.estimate, status: "responded", respondedAt: "2026-11-16T18:00:00.000Z",
      signatureName: "Jon Macray",
      lines: remote.estimate.lines.map((line, index) => ({ ...line, decision: decisions[index] })) };
    cloud.set("GMM-0007", remote);
  };
  answer(["approved", "declined"]);
  click(dom, doc.getElementById("refreshEstimateButton"));
  await settle(() => doc.getElementById("convertEstimateButton"), "the answer to show");
  assert.match(card().textContent, /Signed by Jon Macray/);
  assert.match(card().textContent, /Declined work/);

  click(dom, doc.getElementById("convertEstimateButton"));
  await settle(() => state().estimate?.convertedAt, "conversion");
  let job = state();
  assert.equal(job.laborAmountCents, 20000, "approved labor becomes the flat labor charge");
  assert.equal(job.flatLaborFromEstimate, true);
  assert.deepEqual(job.quotedLines, [], "the declined part is not billed");
  assert.equal(job.shopSuppliesPct, 5);
  assert.equal(job.agreedWork, "Oil filter housing\nApproved estimate: Front brakes");
  await settle(() => doc.getElementById("useTimerLaborButton"), "the flat-labor note");

  // --------------------------------- change & resend: no stacking, no stale labor
  click(dom, doc.getElementById("editEstimateButton"));
  await settle(() => state().estimate.status === "draft", "back to draft");
  assert.equal(state().estimate.token, "", "the old link is dead");
  const removeSaved = doc.querySelector('[data-remove-saved="0"]');
  assert.ok(removeSaved, "saved jobs can be managed while drafting");
  click(dom, removeSaved);
  await settle(() => JSON.parse(store.get("gold-mobile-mechanic-saved-jobs-v1")).length === 0, "the saved job to go");

  click(dom, doc.getElementById("sendEstimateButton"));
  await settle(() => state().estimate.status === "sent" && cloud.get("GMM-0007")?.estimate?.status === "sent", "the resend");
  assert.notEqual(state().estimate.token, firstToken, "a resend mints a new link");
  answer(["declined", "approved"]);
  click(dom, doc.getElementById("refreshEstimateButton"));
  await settle(() => doc.getElementById("convertEstimateButton"), "the second answer");
  click(dom, doc.getElementById("convertEstimateButton"));
  await settle(() => state().quotedLines?.length === 1, "the second conversion");
  job = state();
  assert.equal(job.flatLaborFromEstimate, false, "labor the customer took back is not billed flat");
  assert.equal(job.laborAmountCents, null, "the timer bills labor again");
  assert.equal(job.quotedLines[0].description, "Pad set");
  assert.equal(job.agreedWork, "Oil filter housing\nApproved estimate: Pad set", "replaced, not stacked");

  // ------------------------------------------------ deposit and sales tax
  const deposit = doc.getElementById("depositReceivedInput");
  deposit.value = "50";
  fire(dom, deposit, "change");
  await settle(() => state().depositCents === 5000, "the deposit");
  assert.match(doc.getElementById("runningInvoiceFigures").textContent, /Balance after deposit/);

  const tax = doc.getElementById("invoiceTaxInput");
  tax.value = "10";
  fire(dom, tax, "change");
  await settle(() => state().taxRatePct === 10, "the tax rate");
  assert.match(doc.getElementById("runningInvoiceFigures").textContent, /Tax ·/);
});

test("a filed job that never had an estimate shows no estimate card", { skip: parseHTML ? false : "linkedom is not installed" }, async () => {
  const store = new Map([["gmm-sync-token", "test-device.signature"], ["gold-mobile-mechanic-phone-v1", seedWith({
    status: "invoiced", endedAt: "2026-08-25T15:00:00.000Z",
    invoice: { invoiceNumber: "GMM-INV-0007", createdAt: "2026-08-25T15:00:00.000Z", workSeconds: 3600,
      laborCents: 12000, materialsCents: 0, totalCents: 12000 }
  })]]);
  const { dom } = boot({ store, cloud: new Map(), calls: [] });
  const doc = dom.document;
  await settle(() => doc.querySelector(".invoice-card"), "the filed invoice");
  assert.equal(doc.getElementById("estimateCard"), null);
});

test("flat labor from an estimate can go back to the timer", { skip: parseHTML ? false : "linkedom is not installed" }, async () => {
  const store = new Map([["gmm-sync-token", "test-device.signature"], ["gold-mobile-mechanic-phone-v1", seedWith({
    flatLaborFromEstimate: true, laborAmountCents: 20000,
    estimate: { status: "responded", token: "AbCdEfGhIjKlMnOpQrStUv", convertedAt: "2026-08-25T16:00:00.000Z",
      respondedAt: "2026-08-25T15:30:00.000Z", signatureName: "Jon Macray", taxRatePct: 0, shopSuppliesPct: 0,
      depositCents: 0, notes: "", lines: [{ id: "l1", kind: "labor", description: "Housing", quantity: 2, unitCents: 10000, decision: "approved" }] }
  })]]);
  const { dom } = boot({ store, cloud: new Map(), calls: [] });
  const doc = dom.document;
  const state = () => JSON.parse(store.get("gold-mobile-mechanic-phone-v1")).jobs[0];
  await settle(() => doc.getElementById("useTimerLaborButton"), "the flat-labor note");
  assert.match(doc.getElementById("laborTotalLive").textContent, /\$200\.00/, "labor is the approved flat amount");

  // Typing an adjustment previews against the flat amount, not hours × rate.
  const adjust = doc.getElementById("laborAdjustInput");
  adjust.value = "25";
  adjust.dispatchEvent(new dom.Event("input", { bubbles: true }));
  assert.match(doc.getElementById("laborTotalLive").textContent, /\$225\.00/);
  adjust.value = "";
  adjust.dispatchEvent(new dom.Event("input", { bubbles: true }));

  doc.getElementById("useTimerLaborButton").dispatchEvent(new dom.Event("click", { bubbles: true }));
  await settle(() => state().flatLaborFromEstimate === false, "the switch back");
  assert.equal(state().laborAmountCents, null);
});
