/**
 * Anya, both halves, driven as shipped.
 *
 * Half one is the real Worker: the assistant routes are bundled from the real
 * TypeScript and called through the real router, with the Anthropic API stubbed
 * at `fetch`. What is being proved is not that a model answers — it is that the
 * guards around the model hold: the origin lock, the missing-key 503, the
 * per-caller cap, and above all that a confident `ready: true` cannot open a
 * job while a must-have field is still blank. The model's opinion is an
 * opinion; the app's rule is the rule.
 *
 * Half two is the real phone app in a real DOM. Two things are pinned there,
 * and both are about money:
 *
 *  - The sheet is filled through the actual form inputs, so a conversation that
 *    stops halfway leaves a normal half-filled sheet rather than a dead end.
 *  - A clock-in is REAL before she says it happened. Her tool call comes back
 *    unexecuted, the app runs it through the same `timerAction` the button
 *    uses, and the outcome is posted back as a tool result. A refusal — he is
 *    already on the clock — goes back as an error, because "you're on the
 *    clock" said over a clock that never started is unbilled labour.
 *
 * Needs `linkedom` for half two; it is skipped with a clear message when absent.
 */
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";

const root = new URL("../", import.meta.url);
const DOCS = fileURLToPath(new URL("docs/", root)).replace(/\/$/, "");
const migrationsDir = fileURLToPath(new URL("sync-worker/migrations/", root));
const ORIGIN = "https://thomasg42.github.io";

let parseHTML;
try {
  ({ parseHTML } = await import("linkedom"));
} catch {
  parseHTML = null;
}

// --------------------------------------------------------------- worker side

function makeD1(migrations) {
  const db = new DatabaseSync(":memory:");
  for (const sql of migrations) {
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

async function loadWorker() {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("sync-worker/index.ts", root))],
    bundle: true,
    write: false,
    format: "esm",
    logLevel: "silent"
  });
  const source = result.outputFiles[0].text;
  return (await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`)).default;
}

function reply(content, stop = "end_turn") {
  return new Response(JSON.stringify({ content, stop_reason: stop }),
    { status: 200, headers: { "Content-Type": "application/json" } });
}

test("the worker's assistant routes hold their guards", async () => {
  const worker = await loadWorker();
  const migrations = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()
    .map((f) => readFileSync(`${migrationsDir}${f}`, "utf8"));

  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const address = String(url?.url || url);
    if (!address.startsWith("https://api.anthropic.com/")) return realFetch(url, options);
    const body = JSON.parse(options.body);
    sent.push({ headers: options.headers, body });

    if (body.tools?.some((t) => t.name === "web_search")) {
      const last = body.messages.at(-1);
      // A turn carrying tool results means the phone already did the work.
      if (Array.isArray(last?.content) && last.content.some((b) => b.type === "tool_result")) {
        return reply([{ type: "text", text: "You're on the clock." }]);
      }
      if (String(last?.content || "").includes("clock me in")) {
        return reply([
          { type: "text", text: "Starting you now." },
          { type: "tool_use", id: "toolu_01", name: "clock_in", input: {} }
        ], "tool_use");
      }
      const named = String(last?.content || "").includes("no link")
        ? "" : " https://www.youtube.com/watch?v=aaaaaaaaaaa";
      return reply([
        { type: "web_search_tool_result", content: [
          // A YouTube hit the model saw but did NOT pick, plus an error-shaped
          // result object, which the worker must not try to index into.
          { url: "https://www.youtube.com/watch?v=zzzzzzzzzzz", title: "Some other job" },
          { url: "https://example.com/specs", title: "Specs" }
        ] },
        { type: "web_search_tool_result", content: { error_code: "max_uses_exceeded" } },
        { type: "text", text: `Here's a video on it.${named} I could not confirm the torque for that exact year.` }
      ]);
    }

    return reply([{ type: "text", text: JSON.stringify({
      say: "What's the labor rate?",
      fields: {
        customerName: "Josh Perkens", customerPhone: "", customerEmail: "",
        vehicleYear: "2015", vehicleMake: "Chevrolet", vehicleModel: "Suburban",
        vehiclePlate: "", agreedWork: "Replace the exhaust clamp", laborRate: ""
      },
      materials: ["GM exhaust clamp"],
      notes: "Both front struts are blown and were not quoted.",
      // The model claims it is finished while the rate is still blank, and asks
      // to start a clock on a job that would not exist. The Worker must
      // overrule both.
      ready: true,
      clockIn: true
    }) }]);
  };

  try {
    const env = { DB: makeD1(migrations), ANTHROPIC_API_KEY: "sk-ant-test" };
    const call = (path, body, { origin = ORIGIN, method = "POST" } = {}) =>
      worker.fetch(new Request(`https://sync.example.com${path}`, {
        method,
        headers: { ...(origin ? { Origin: origin } : {}), "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body)
      }), env);

    const turn = [{ role: "user", content: "Josh's Suburban, exhaust clamp." }];

    // --------------------------------------- the credential is server-side only
    const unset = await worker.fetch(new Request("https://sync.example.com/api/assistant/invoice", {
      method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ messages: turn })
    }), { DB: makeD1(migrations) });
    assert.equal(unset.status, 503, "no key means 503, not a broken call to Anthropic");

    // ------------------------------------------------------- origin is locked
    assert.equal((await call("/api/assistant/chat", { messages: turn },
      { origin: "https://evil.example" })).status, 403, "another site cannot spend the API key");
    assert.equal((await call("/api/assistant/chat", { messages: turn },
      { origin: "" })).status, 403, "a server-side caller with no Origin cannot either");

    const health = await worker.fetch(
      new Request("https://sync.example.com/api/health", { headers: { Origin: ORIGIN } }), env);
    assert.equal((await health.json()).assistant, true, "the app can tell she is configured");

    // ----------------------------- THE REGRESSION: ready and clockIn are overruled
    let response = await call("/api/assistant/invoice", { messages: turn });
    let body = await response.json();
    assert.equal(body.ready, false, "ready is refused while a must-have field is blank");
    assert.equal(body.clockIn, false, "and no clock starts on a job that was not created");
    assert.deepEqual(body.missing, ["laborRate"], "the app is told which field is missing");
    assert.equal(body.fields.customerName, "Josh Perkens");
    assert.ok(!("customerPhone" in body.fields), "an empty field is dropped, never sent as a change");
    assert.deepEqual(body.materials, ["GM exhaust clamp"]);
    assert.match(body.notes, /Both front struts are blown/, "the aside he mentioned is kept for the invoice");

    body = await (await call("/api/assistant/invoice", { messages: turn, filled: { laborRate: "125" } })).json();
    assert.equal(body.ready, true, "ready stands once nothing is missing");
    assert.equal(body.clockIn, true, "and the clock-in rides with it");

    // --------------------------------------------------- the model call itself
    let request = sent.at(-1);
    assert.equal(request.headers["x-api-key"], "sk-ant-test");
    assert.equal(request.headers["anthropic-version"], "2023-06-01");
    assert.equal(request.body.model, "claude-opus-5");
    assert.equal(request.body.output_config.format.type, "json_schema");
    assert.ok(!("thinking" in request.body),
      "thinking is left at the Opus 5 default — disabling it leaks tool-shaped text into the reply");
    assert.match(request.body.system[0].text, /Never invent or suggest a labor rate/,
      "the pricing gate is in the shipped prompt, not just in a comment");

    await call("/api/assistant/invoice", { messages: turn, vehicles: [{
      customerName: "Josh Perkens", vehicleYear: "2015", vehicleMake: "Chevrolet",
      vehicleModel: "Suburban", vehiclePlate: "MT-1234"
    }] });
    assert.match(sent.at(-1).body.system[1].text,
      /Josh Perkens: 2015 Chevrolet Suburban \(plate MT-1234\)/);

    // ------------------------------------------------------------- chat mode
    body = await (await call("/api/assistant/chat", {
      messages: [{ role: "user", content: "How do I change a rack and pinion?" }],
      job: { customerName: "Perk", vehicleYear: "2016", vehicleMake: "Chevrolet",
        vehicleModel: "Silverado 1500", status: "in_progress", agreedWork: "Thermostat" }
    })).json();
    assert.deepEqual(body.videos, [{ id: "aaaaaaaaaaa", url: "https://www.youtube.com/watch?v=aaaaaaaaaaa" }],
      "the video the answer NAMED wins over another YouTube hit in the same results");
    assert.deepEqual(body.actions, [], "an answer with no tool call asks the phone to do nothing");

    request = sent.at(-1);
    assert.equal(request.body.tools[0].type, "web_search_20260209");
    assert.ok(!request.body.tools.some((t) => t.name === "code_execution"),
      "no second execution environment alongside the dynamic-filtering search tool");
    assert.deepEqual(
      request.body.tools.filter((t) => !t.type).map((t) => t.name).sort(),
      ["add_note", "clock_in", "clock_out", "set_agreed_work"],
      "she is given exactly the four tools the phone knows how to run");
    assert.match(request.body.system[0].text, /Never state a torque spec/,
      "the safety rule on specs is in the shipped prompt");
    assert.match(request.body.system[1].text, /2016 Chevrolet Silverado 1500/);
    assert.match(request.body.system[1].text, /ON THE CLOCK right now/,
      "she is told the clock state, so 'am I clocked in' is answerable without a tool");

    body = await (await call("/api/assistant/chat", {
      messages: [{ role: "user", content: "rack and pinion, no link" }]
    })).json();
    assert.deepEqual(body.videos, [{ id: "zzzzzzzzzzz", url: "https://www.youtube.com/watch?v=zzzzzzzzzzz" }],
      "an un-named video falls back to a searched result rather than showing none");
    assert.match(sent.at(-1).body.system[1].text, /No job is open/,
      "with no job open she is told the tools cannot run");

    // ------------------------- a job-changing call comes back UNEXECUTED
    body = await (await call("/api/assistant/chat", {
      messages: [{ role: "user", content: "clock me in" }],
      job: { customerName: "Perk", vehicleMake: "Chevrolet", vehicleModel: "Silverado", status: "clocked_out" }
    })).json();
    assert.deepEqual(body.actions, [{ id: "toolu_01", name: "clock_in", input: {} }],
      "the worker hands the clock-in to the phone instead of running it");
    assert.ok(Array.isArray(body.assistant),
      "and echoes the assistant turn back so the tool result can be matched to it");
    assert.match(body.say, /Starting you now/);

    // The phone's answer goes back as blocks, and must survive the round trip.
    body = await (await call("/api/assistant/chat", {
      messages: [
        { role: "user", content: "clock me in" },
        { role: "assistant", content: body.assistant },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01", content: "Clocked in." }] }
      ],
      job: { customerName: "Perk", vehicleMake: "Chevrolet", vehicleModel: "Silverado", status: "in_progress" }
    })).json();
    assert.deepEqual(body.actions, []);
    assert.match(body.say, /on the clock/);
    const roundTrip = sent.at(-1).body.messages;
    assert.equal(roundTrip.length, 3, "no turn was dropped or merged across the tool call");
    assert.equal(roundTrip[2].content[0].tool_use_id, "toolu_01",
      "the tool result still points at the call that asked for it");

    // ---------------------------------------------------------- bad input
    assert.equal((await call("/api/assistant/invoice", { messages: [] })).status, 400);
    assert.equal((await call("/api/assistant/invoice",
      { messages: [{ role: "assistant", content: "hi" }] })).status, 400,
      "a transcript that does not end on the user is refused rather than sent");
    assert.equal((await call("/api/assistant/nope", { messages: turn })).status, 404);
    assert.equal((await call("/api/assistant/invoice", undefined, { method: "GET" })).status, 404);

    // An agent reply that came back with an empty `say` leaves the phone
    // sending two user turns in a row. Roles must alternate, so they are merged
    // rather than passed through as a request the API would refuse outright.
    await call("/api/assistant/invoice", { messages: [
      { role: "user", content: "Josh's Suburban" },
      { role: "assistant", content: "   " },
      { role: "user", content: "exhaust clamp" }
    ] });
    const merged = sent.at(-1).body.messages;
    assert.equal(merged.length, 1, "the empty assistant turn does not split the user into two");
    assert.match(merged[0].content, /Josh's Suburban\nexhaust clamp/);

    // ------------------------------------------------------------ spend cap
    const before = sent.length;
    let limited = 0;
    for (let i = 0; i < 45; i += 1) {
      const r = await call("/api/assistant/chat", { messages: [{ role: "user", content: `q${i}` }] });
      if (r.status === 429) limited += 1;
    }
    assert.ok(limited > 0, "a runaway caller is cut off instead of spending without limit");
    assert.ok(sent.length - before < 45, "and the calls that were cut off never reached Anthropic");
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ------------------------------------------------------------------ app side

function boot({ store, routes, calls, hash = "" }) {
  const { window: dom } = parseHTML(readFileSync(`${DOCS}/index.html`, "utf8"));
  const doc = dom.document;

  const form = doc.getElementById("jobForm");
  const formProto = Object.getPrototypeOf(form);
  formProto.reset = function reset() {
    this.querySelectorAll("input, textarea, select").forEach((el) => { el.value = ""; });
  };
  formProto.requestSubmit = function requestSubmit() {
    this.dispatchEvent(new dom.Event("submit"));
  };
  // Patched on the prototype, not the instances: the voice overlay and the chat
  // panel both build their own <dialog> at runtime and both have to be modal.
  const dialogProto = Object.getPrototypeOf(doc.querySelector("dialog"));
  dialogProto.showModal = function showModal() { this.setAttribute("open", ""); this.open = true; };
  dialogProto.close = function close() { this.removeAttribute("open"); this.open = false; };

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
    Blob: globalThis.Blob, FormData: ShimFormData, URL: globalThis.URL, Audio: class {},
    Event: dom.Event, CustomEvent: dom.CustomEvent, Image: class {},
    document: doc, confirm: () => true, alert: () => {},
    fetch: async (url, options = {}) => {
      const address = String(url);
      const method = options.method || "GET";
      const body = options.body ? JSON.parse(options.body) : null;
      calls.push({ url: address, method, body });
      for (const [suffix, handler] of Object.entries(routes)) {
        if (address.endsWith(suffix)) {
          return new Response(JSON.stringify(handler(body)), { status: 200 });
        }
      }
      // A job upload must echo the job back. Without it the sync queue never
      // settles and the app hangs at boot before it routes to anything.
      if (/\/api\/jobs\/[^/]+$/.test(address) && method === "PUT") {
        return new Response(JSON.stringify({ job: body }), { status: 200 });
      }
      return new Response(JSON.stringify({ recorded: true }), { status: 200 });
    }
  };
  context.window = context;
  context.self = context;
  context.location = { hash, origin: ORIGIN, pathname: "/gmm/index.html" };
  context.addEventListener = () => {};
  context.scrollTo = () => {};
  context.matchMedia = () => ({ matches: false, addEventListener() {} });

  vm.createContext(context);
  for (const file of ["voice-config.js", "assistant.js", "app.js"]) {
    vm.runInContext(readFileSync(`${DOCS}/${file}`, "utf8"), context, { filename: file });
  }
  return { dom, context };
}

/** Stands in for GMMVoice with a scripted set of spoken answers. */
function fakeVoice(answers, spoken) {
  return {
    prime: () => {}, raise: () => {}, stop: () => {}, isRunning: () => false, supported: () => true,
    speak: async (text) => { spoken.push(text); },
    parse: { yesNo: (heard) => /^(yes|yeah|yep|correct|that's right)/i.test(String(heard || "")) },
    run: async (flow) => {
      try {
        const result = await flow({
          speak: async (text) => { spoken.push(text); },
          listen: async () => {
            if (!answers.length) throw new Error("stopped");
            return answers.shift();
          },
          typedAnswer: () => new Promise(() => {}),
          setState: () => {}
        });
        if (flow.farewell !== null) spoken.push(flow.farewell || "All set.");
        return { ok: true, result };
      } catch {
        return { ok: false, reason: "cancelled" };
      }
    }
  };
}

const settle = async (until, label = "the app") => {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    await new Promise((r) => setTimeout(r, 5));
    if (!until || until()) return;
  }
  throw new Error(`timed out waiting for ${label}`);
};

test("Talk to Anya fills the real sheet, saves only on a yes, and starts the clock when asked",
  { skip: parseHTML ? false : "linkedom is not installed" }, async () => {
  const store = new Map();
  const calls = [];
  const spoken = [];

  const readBack = "Josh Perkens, 2015 Chevrolet Suburban, exhaust clamp, a hundred and twenty five an hour. Right?";
  const agentReplies = [
    { say: "Whose car are we on?", fields: {}, materials: [], notes: "", ready: false, clockIn: false },
    { say: "What are we doing to it?",
      fields: { customerName: "Josh Perkens", vehicleYear: "2015", vehicleMake: "Chevrolet", vehicleModel: "Suburban" },
      materials: [], notes: "Both front struts are blown and were not quoted.", ready: false, clockIn: false },
    { say: readBack, fields: { agreedWork: "Replace the exhaust clamp", laborRate: "125" },
      materials: ["GM exhaust clamp"], notes: "", ready: true, clockIn: false },
    // He said no, so she asks what to fix — and he walks away mid-answer.
    { say: "What do you want changed?", fields: {}, materials: [], notes: "", ready: false, clockIn: false },
    // Second run: same read-back, and this time start the clock.
    { say: readBack, fields: {}, materials: [], notes: "", ready: true, clockIn: true }
  ];

  const { dom, context } = boot({
    store, calls,
    routes: {
      "/api/health": () => ({ ok: true, assistant: true }),
      "/api/assistant/invoice": () => agentReplies.shift(),
      "/api/jobs": () => ({ jobs: [] })
    }
  });
  const doc = dom.document;
  const state = () => JSON.parse(store.get("gold-mobile-mechanic-phone-v1") || '{"jobs":[]}');

  await settle(() => !doc.getElementById("talkRow").classList.contains("hidden"), "her buttons to appear");
  assert.ok(!doc.getElementById("shopAgentButton").classList.contains("hidden"));
  assert.match(doc.getElementById("talkItInButton").textContent, /Talk to Anya/);
  assert.match(doc.getElementById("shopAgentButton").textContent, /Ask Anya/);

  const addInvoice = doc.getElementById("newJobButton");
  assert.match(addInvoice.textContent.trim(), /Add invoice/);
  assert.equal(doc.getElementById("voiceNewJobButton"), null,
    "the old scripted new-job-by-voice button is gone, not merely hidden");

  addInvoice.dispatchEvent(new dom.Event("click"));
  await settle(() => doc.getElementById("jobDialog").open, "the invoice sheet");

  // Something he typed himself before talking must survive the whole run.
  const field = (name) => doc.querySelector(`#jobForm [name="${name}"]`);
  field("customerPhone").value = "406 555 0101";

  context.GMMVoice = fakeVoice(["Josh Perkens' Suburban", "Exhaust clamp", "no"], spoken);
  doc.getElementById("talkItInButton").dispatchEvent(new dom.Event("click"));
  await settle(() => spoken.some((line) => line === readBack), "the read-back");

  assert.equal(field("customerName").value, "Josh Perkens");
  assert.equal(field("vehicleModel").value, "Suburban");
  assert.equal(field("laborRate").value, "125");
  assert.equal(field("customerPhone").value, "406 555 0101",
    "an empty field in the reply means no change — it never wipes what was typed");
  assert.equal(state().jobs.length, 0, "a 'no' on the read-back saves nothing");

  context.GMMVoice = fakeVoice(["yes"], spoken);
  doc.getElementById("talkItInButton").dispatchEvent(new dom.Event("click"));
  await settle(() => state().jobs.length === 1, "the job to be created");

  const saved = state().jobs[0];
  assert.equal(saved.customerName, "Josh Perkens");
  assert.equal(saved.customerPhone, "406 555 0101");
  assert.match(saved.suggestions, /Both front struts are blown/,
    "the aside he mentioned in passing landed on the notes that print on the invoice");
  assert.equal(saved.status, "in_progress", "she was told to start the clock, so the clock started");
  assert.ok(saved.timeEntries.some((entry) => entry.kind === "work" && !entry.endedAt),
    "and a real open billable interval exists, not just a status");
  assert.ok(spoken.includes("Saved, and you're on the clock."));

  // ------------------------------------- the cars picker offers the saved car
  addInvoice.dispatchEvent(new dom.Event("click"));
  await settle(() => !doc.getElementById("carPicker").classList.contains("hidden"), "the car picker");
  const chips = doc.querySelectorAll("#carChips .car-chip");
  assert.equal(chips.length, 1, "the job just saved is now a tappable car");
  assert.match(chips[0].textContent, /2015 Chevrolet Suburban/);
  chips[0].dispatchEvent(new dom.Event("click", { bubbles: true }));
  await settle(() => field("customerName").value === "Josh Perkens", "the car to fill itself in");
  assert.equal(field("customerPhone").value, "406 555 0101",
    "tapping a car brings the customer across, not just the vehicle");
});

const SEED = {
  version: 1,
  jobs: [{
    id: "GMM-0007", customerName: "Perk", customerPhone: "", customerEmail: "",
    vehicleYear: "2016", vehicleMake: "Chevrolet", vehicleModel: "Silverado 1500", vehiclePlate: "",
    laborRateCents: 12500, status: "clocked_out", materials: [], receipts: [],
    timeEntries: [{ id: "t1", kind: "work", startedAt: "2026-09-12T14:00:00.000Z", endedAt: "2026-09-12T15:00:00.000Z" }],
    eventHistory: [], agreedWork: "Thermostat", suggestions: "",
    startedAt: "2026-09-12T14:00:00.000Z", createdAt: "2026-09-12T14:00:00.000Z",
    updatedAt: "2026-09-12T14:00:00.000Z"
  }]
};

test("Ask Anya clocks him in for real before she says she did",
  { skip: parseHTML ? false : "linkedom is not installed" }, async () => {
  const store = new Map([["gold-mobile-mechanic-phone-v1", JSON.stringify(SEED)]]);
  const calls = [];
  const spoken = [];

  const assistantTurn = [
    { type: "text", text: "Starting you now." },
    { type: "tool_use", id: "toolu_01", name: "clock_in", input: {} }
  ];
  const chatReplies = [
    { say: "Starting you now.", videos: [], actions: [{ id: "toolu_01", name: "clock_in", input: {} }], assistant: assistantTurn },
    { say: "You're on the clock.", videos: [], actions: [], assistant: null },
    // Asked a second time, with the clock already running.
    { say: "Starting you now.", videos: [], actions: [{ id: "toolu_02", name: "clock_in", input: {} }], assistant: assistantTurn },
    { say: "You're already on it.", videos: [], actions: [], assistant: null }
  ];

  const { dom, context } = boot({
    store, calls, hash: "#job/GMM-0007",
    routes: {
      "/api/health": () => ({ ok: true, assistant: true }),
      "/api/assistant/chat": () => chatReplies.shift(),
      "/api/jobs": () => ({ jobs: [] })
    }
  });
  const doc = dom.document;
  const job = () => JSON.parse(store.get("gold-mobile-mechanic-phone-v1")).jobs[0];
  context.GMMVoice = fakeVoice([], spoken);

  await settle(() => !doc.getElementById("jobView").classList.contains("hidden"), "the work order");
  await settle(() => doc.getElementById("jobShopAgentButton")
    && !doc.getElementById("jobShopAgentButton").classList.contains("hidden"), "Ask Anya on the job");

  doc.getElementById("jobShopAgentButton").dispatchEvent(new dom.Event("click"));
  await settle(() => doc.querySelector(".agent-panel")?.open, "the chat panel");

  // The app back-fills clock history from a job's existing time entries at
  // boot, so the baseline is whatever that produced — not zero.
  const clockIns = () => job().eventHistory.filter((event) => event.action === "clock_in").length;
  const baseline = clockIns();

  const panel = doc.querySelector(".agent-panel");
  assert.match(panel.querySelector("#agentVehicle").textContent, /2016 Chevrolet Silverado 1500/,
    "she opens knowing which truck he is standing at");

  const askHer = async (question, until) => {
    panel.querySelector("#agentInput").value = question;
    panel.querySelector("#agentComposer").dispatchEvent(new dom.Event("submit"));
    await settle(until, `the answer to "${question}"`);
  };

  // ------------------------------------------- THE ONE THAT MATTERS: it is real
  await askHer("clock me in", () => job().status === "in_progress");
  assert.ok(job().timeEntries.some((entry) => entry.kind === "work" && !entry.endedAt),
    "a real open billable interval was opened, not just a status flipped");
  assert.equal(clockIns(), baseline + 1,
    "and it is on the append-only clock history like any other clock-in");

  await settle(() => chatReplies.length === 2, "the tool result to go back");
  const followUp = calls.filter((c) => c.url.endsWith("/api/assistant/chat")).at(-1).body.messages;
  const result = followUp.at(-1);
  assert.equal(result.role, "user");
  assert.equal(result.content[0].type, "tool_result");
  assert.equal(result.content[0].tool_use_id, "toolu_01",
    "the result points back at the call that asked for it");
  assert.match(result.content[0].content, /Clocked in/);
  assert.ok(!result.content[0].is_error, "a clock-in that worked is not reported as an error");
  assert.deepEqual(followUp.at(-2).content, assistantTurn,
    "her tool-calling turn is echoed back verbatim, or the API cannot match the result");

  // What she did is on screen as its own line, not buried in a sentence.
  assert.match(panel.querySelector(".agent-did")?.textContent || "", /Clocked in/);

  // ------------------------------------- a refusal goes back AS a refusal
  await askHer("clock me in", () => chatReplies.length === 0);
  const second = calls.filter((c) => c.url.endsWith("/api/assistant/chat")).at(-1).body.messages;
  const refusal = second.at(-1).content[0];
  assert.equal(refusal.is_error, true,
    "already on the clock comes back as an error, so she cannot claim a clock-in that never happened");
  assert.match(refusal.content, /already on the clock/);
  assert.equal(job().status, "in_progress", "and nothing about the job changed");

  assert.equal(clockIns(), baseline + 1,
    "a refused clock-in writes no second event — the history stays honest");
});

/**
 * The three phone rules that fail silently.
 *
 * None of these throw, none show up in a desktop browser, and all three make
 * the app feel broken in a driveway: a sub-16px input makes iOS zoom the page
 * on focus and never zoom back; `vh` keeps its full-screen value when the
 * keyboard opens and buries the box he is typing into; and a composer with no
 * safe-area padding sits under the home indicator on every modern iPhone.
 */
test("the agent surfaces are built for a phone", () => {
  const css = readFileSync(`${DOCS}/styles.css`, "utf8");
  const agent = css.slice(css.indexOf("Anya"));

  const composerInput = agent.slice(agent.indexOf(".agent-composer input"));
  assert.match(composerInput.slice(0, 400), /font-size:\s*16px/,
    "the chat input is 16px or iOS zooms the page on focus and never zooms back");

  assert.match(agent, /\.agent-panel\s*{[^}]*max-height:\s*88dvh/,
    "the panel is sized in dvh, so the keyboard does not bury the composer");
  assert.match(agent, /\.agent-composer\s*{[^}]*env\(safe-area-inset-bottom\)/,
    "the composer clears the home indicator");

  // Thumb targets. A miss costs him a second look at a screen he is holding to
  // avoid looking at.
  for (const [selector, pattern] of [
    [".agent-mic", /\.agent-mic\s*{[^}]*height:\s*50px/],
    [".button-talk", /\.button-talk\s*{[^}]*min-height:\s*54px/],
    [".car-chip", /\.car-chip\s*{[^}]*min-height:\s*56px/]
  ]) {
    assert.match(agent, pattern, `${selector} is big enough to hit with a thumb`);
  }

  // Phone-first: the wide layout is behind min-width, never the other way round.
  assert.match(agent, /@media \(min-width: 620px\)/,
    "the desktop layout is the exception, not the default");
  assert.ok(!/@media \(max-width: \d+px\)[^@]*\.agent-panel\s*{/.test(agent),
    "the panel is not defined desktop-first and patched down for phones");
  assert.match(agent, /@media \(hover: hover\)/,
    "hover styles are gated, because a thumb never hovers");
});
