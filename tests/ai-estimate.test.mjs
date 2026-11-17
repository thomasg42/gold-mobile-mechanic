/**
 * The AI estimate end to end: the Worker route against a mocked Anthropic API
 * (request shape, one call, never retried, only safe shapes out), then the
 * phone — manual button, automatic run on a new job, redo, and the gates that
 * keep an unpriced or unchecked AI line from reaching a customer.
 * Phone harness copied from job-edit.test.mjs. Needs `linkedom`.
 */
import { build } from "esbuild";
import { TEST_PIN, authHeader } from "./pair-helper.mjs";
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

function boot({ store, cloud, calls, extra }) {
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
    btoa: globalThis.btoa, prompt: () => "", structuredClone: globalThis.structuredClone,
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
      if (extra) {
        const answer = await extra(address, options);
        if (answer) return answer;
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


// ------------------------------------------------------------------ Worker

async function loadWorker() {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("../sync-worker/index.ts", import.meta.url))],
    bundle: true, write: false, format: "esm", logLevel: "silent"
  });
  return (await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`)).default;
}

const MODEL_REPLY = {
  action: "estimate",
  jobs: [
    { title: "Front struts, both sides", hours: 2.5, note: "Assumed quick-strut assemblies.",
      parts: [{ name: "Front strut assembly", quantity: 2 }],
      consumables: [{ name: "Strut mount nuts (one-time)", quantity: 6 }] },
    { title: "Timing cover gasket", hours: 99, note: "", parts: [], consumables: [] },
    { title: "  ", hours: 1, note: "", parts: [], consumables: [] }
  ]
};

function anthropicReply(payload, stopReason = "end_turn") {
  return new Response(JSON.stringify({
    content: [{ type: "text", text: JSON.stringify(payload) }], stop_reason: stopReason
  }), { status: 200 });
}

test("worker: AI estimate route", async () => {
  const worker = await loadWorker();
  // The assistant routes rate-limit through D1; a counter table that always admits is enough here.
  const DB = { prepare() { const s = { bind() { return s; }, async first() { return { count: 1 }; }, async run() { return { success: true, meta: { changes: 1 } }; }, async all() { return { results: [] }; } }; return s; } };
  const env = { DB, OWNER_PIN: TEST_PIN };
  const call = (body, { headers = {} } = {}) => worker.fetch(new Request("https://sync.example.com/api/assistant/estimate", {
    method: "POST",
    headers: { Origin: "https://thomasg42.github.io", "Content-Type": "application/json", ...authHeader(), ...headers },
    body: JSON.stringify(body)
  }), env);

  const sent = [];
  let reply = () => anthropicReply(MODEL_REPLY);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    assert.equal(new URL(String(url)).hostname, "api.anthropic.com");
    sent.push({ headers: init.headers, body: JSON.parse(init.body) });
    return reply();
  };
  const request = { vehicle: { year: "2014", make: "Chevrolet", model: "Cruze" }, work: "Front struts and timing cover gasket" };
  try {
    let r = await call(request);
    assert.equal(r.status, 503, "no key: says so instead of failing silently");
    env.ANTHROPIC_API_KEY = "sk-test";

    assert.equal((await call(request, { headers: { Authorization: "" } })).status, 401, "behind the PIN gate");
    assert.equal((await call(request, { headers: { Origin: "https://evil.example" } })).status, 403, "app origin only");
    assert.equal((await call({ vehicle: { make: "Chevrolet" }, work: "" })).status, 400);
    assert.equal(sent.length, 0, "nothing billable before the input is valid");

    r = await call(request);
    assert.equal(r.status, 200);
    assert.equal(sent.length, 1, "exactly one model call");
    const { headers, body } = sent[0];
    assert.equal(body.model, "claude-opus-5-5");
    assert.equal(headers["anthropic-beta"], "server-side-fallback-2026-07-01");
    assert.equal(body.fallbacks, "default");
    assert.equal(body.output_config.effort, "low");
    assert.equal(body.output_config.format.type, "json_schema");
    assert.equal(body.tools, undefined, "no tools");
    assert.match(body.messages[0].content, /Vehicle: 2014 Chevrolet Cruze\nWork: Front struts and timing cover gasket/);
    assert.match(body.system[0].text, /No prices of any kind/);

    const out = await r.json();
    assert.equal(out.source, "ai");
    assert.match(out.label, /AI estimate — verify/);
    assert.equal(out.jobs.length, 1, "a 99-hour job and a blank title never reach the phone");
    assert.deepEqual(out.jobs[0], {
      title: "Front struts, both sides", hours: 2.5, note: "Assumed quick-strut assemblies.",
      parts: [{ name: "Front strut assembly", quantity: 2 }],
      consumables: [{ name: "Strut mount nuts (one-time)", quantity: 6 }]
    });
    assert.ok(!JSON.stringify(out).match(/price|cents|\$/i), "no prices come back");

    // Refusal, truncation, unknown, upstream failure: a sentence, one call, no retry.
    for (const [make, status, pattern] of [
      [() => anthropicReply(MODEL_REPLY, "refusal"), 502, /declined/],
      [() => anthropicReply(MODEL_REPLY, "max_tokens"), 502, /cut off/],
      [() => anthropicReply({ action: "unknown", jobs: [] }), 422, /couldn't estimate/],
      [() => new Response("overloaded", { status: 529 }), 502, /could not answer/]
    ]) {
      reply = make;
      const before = sent.length;
      r = await call(request);
      assert.equal(r.status, status);
      assert.match((await r.json()).error, pattern);
      assert.equal(sent.length, before + 1, "never retried");
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ------------------------------------------------------------------- phone

const ESTIMATE_RESULT = {
  source: "ai", label: "AI estimate — verify. Not official book time.",
  jobs: [{ title: "Oil filter housing gasket", hours: 2.5, note: "Assumed 1.4L turbo.",
    parts: [{ name: "Oil filter housing", quantity: 1 }],
    consumables: [{ name: "Engine coolant (Dex-Cool)", quantity: 2 }] }]
};

function estimateRoute(log, result = ESTIMATE_RESULT) {
  return async (address, options) => {
    if (!address.endsWith("/api/assistant/estimate")) return null;
    log.push(JSON.parse(options.body));
    return new Response(JSON.stringify(result), { status: 200 });
  };
}

test("phone: the AI estimate fills the estimate, tagged, priced by hand", { skip: parseHTML ? false : "linkedom is not installed" }, async () => {
  const store = new Map([["gmm-sync-token", "test-device.signature"], ["gold-mobile-mechanic-phone-v1", JSON.stringify(SEED)]]);
  const asked = [];
  const confirms = [];
  const { dom, context } = boot({ store, cloud: new Map(), calls: [], extra: estimateRoute(asked) });
  context.confirm = (message) => { confirms.push(message); return true; };
  const doc = dom.document;
  const state = () => JSON.parse(store.get("gold-mobile-mechanic-phone-v1")).jobs[0];
  const click = (el) => el.dispatchEvent(new dom.Event("click", { bubbles: true }));

  await settle(() => doc.getElementById("estimateCard"), "the work order");
  assert.equal(doc.getElementById("jobShopAgentButton"), null, "no general Ask Anya on the vehicle screen");

  click(doc.getElementById("aiEstimateButton"));
  await settle(() => state().aiEstimate, "the AI estimate");
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0], { vehicle: { year: "2014", make: "Chevrolet", model: "Cruze" }, work: "Oil filter housing" });

  let lines = state().estimate.lines;
  assert.deepEqual(lines.map((l) => [l.kind, l.description, l.quantity, l.unitCents, l.source]), [
    ["labor", "Oil filter housing gasket", 2.5, 12000, "ai"],
    ["part", "Oil filter housing", 1, 0, "ai"],
    ["part", "Engine coolant (Dex-Cool)", 2, 0, "ai"]
  ], "labor at this job's rate; parts at $0 for him to price");
  assert.deepEqual(state().materials.map((m) => m.description), ["Oil filter housing", "Engine coolant (Dex-Cool) × 2"]);
  await settle(() => doc.getElementById("aiEstimatePanel"), "the AI panel");
  const panel = doc.getElementById("aiEstimatePanel").textContent;
  assert.match(panel, /AI estimate — verify/);
  assert.match(panel, /2\.5 hr · \$300\.00 labor at \$120\.00\/hr/);
  assert.match(panel, /Not official book time/);
  assert.equal(doc.querySelectorAll("#estimateCard .ai-tag").length, 3, "every AI line is tagged");

  // Unpriced parts cannot go to a customer.
  click(doc.getElementById("sendEstimateButton"));
  await settle(() => /needs a description and a price/.test(doc.getElementById("toast").textContent), "the price gate");
  assert.equal(state().estimate.status, "draft");

  // A line he typed himself survives a redo; the AI's own lines are replaced.
  click(doc.querySelector('[data-add-line="fee"]'));
  await settle(() => doc.querySelectorAll("[data-estimate-line]").length === 4, "his fee line");
  const rows = doc.querySelectorAll("[data-estimate-line]");
  const set = (row, field, value) => { row.querySelector(`[data-line-field="${field}"]`).value = value; };
  set(rows[3], "description", "Diagnostic fee"); set(rows[3], "unitCents", "50");
  click(doc.getElementById("aiEstimateButton"));
  await settle(() => asked.length === 2 && !doc.querySelector("#aiEstimateButton[disabled]"), "the redo");
  lines = state().estimate.lines;
  assert.equal(lines.filter((l) => l.source === "ai").length, 3, "not doubled");
  assert.ok(lines.some((l) => l.description === "Diagnostic fee" && l.unitCents === 5000), "his line is kept");
  assert.equal(state().materials.length, 2, "the checklist is not doubled either");

  // Priced, it sends, but only after he confirms he checked the AI lines.
  doc.querySelectorAll("[data-estimate-line]").forEach((row) => {
    if (row.querySelector('[data-line-field="unitCents"]').value === "0.00") set(row, "unitCents", "40");
  });
  click(doc.getElementById("sendEstimateButton"));
  await settle(() => state().estimate.status === "sent", "the send");
  assert.ok(confirms.some((message) => /came from the AI estimate/.test(message)));
});

test("phone: a new job gets its AI estimate once, automatically", { skip: parseHTML ? false : "linkedom is not installed" }, async () => {
  const store = new Map([["gmm-sync-token", "test-device.signature"], ["gold-mobile-mechanic-phone-v1", JSON.stringify({ version: 1, jobs: [] })]]);
  const asked = [];
  const { dom, context } = boot({ store, cloud: new Map(), calls: [], extra: estimateRoute(asked) });
  context.location.hash = "";
  context.GMMAgent = { available: async () => true };
  const doc = dom.document;
  await settle(() => doc.getElementById("jobForm"), "the app");
  const fill = (name, value) => { doc.querySelector(`#jobForm [name="${name}"]`).value = value; };
  fill("customerName", "Jane Rivera"); fill("vehicleYear", "2014"); fill("vehicleMake", "Chevrolet");
  fill("vehicleModel", "Cruze"); fill("agreedWork", "Oil filter housing"); fill("laborRate", "125");
  doc.getElementById("jobForm").dispatchEvent(new dom.Event("submit"));
  const job = () => JSON.parse(store.get("gold-mobile-mechanic-phone-v1")).jobs[0];
  await settle(() => job()?.aiEstimate, "the automatic estimate");
  assert.equal(asked.length, 1, "one call per new job");
  assert.equal(job().estimate.lines[0].unitCents, 12500, "at the new job's rate");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(asked.length, 1, "and never again on its own");
});

test("phone: no assistant configured, no automatic call", { skip: parseHTML ? false : "linkedom is not installed" }, async () => {
  const store = new Map([["gmm-sync-token", "test-device.signature"], ["gold-mobile-mechanic-phone-v1", JSON.stringify({ version: 1, jobs: [] })]]);
  const asked = [];
  const { dom, context } = boot({ store, cloud: new Map(), calls: [], extra: estimateRoute(asked) });
  context.location.hash = "";
  const doc = dom.document;
  await settle(() => doc.getElementById("jobForm"), "the app");
  const fill = (name, value) => { doc.querySelector(`#jobForm [name="${name}"]`).value = value; };
  fill("customerName", "Jane Rivera"); fill("vehicleMake", "Chevrolet"); fill("vehicleModel", "Cruze");
  fill("agreedWork", "Oil filter housing"); fill("laborRate", "125");
  doc.getElementById("jobForm").dispatchEvent(new dom.Event("submit"));
  await settle(() => JSON.parse(store.get("gold-mobile-mechanic-phone-v1")).jobs.length === 1, "the job");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(asked.length, 0);
});
