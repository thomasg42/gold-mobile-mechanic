/**
 * Drives docs/app.js exactly as shipped, inside the real docs/index.html, in a
 * real DOM. The clock buttons are tapped the way a thumb taps them, so this
 * covers the state machine, the per-event persistence, and the offline queue
 * rather than the text of the file.
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

test("clocking in and out saves each event on its own, immediately", { skip: parseHTML ? false : "linkedom is not installed" }, async () => {
  // Already paired: pairing itself is covered in sync-auth.test.mjs, and an
  // unpaired store would park these suites on a PIN prompt.
  const store = new Map([["gmm-sync-token", "test-device.signature"]]);
  const calls = [];

  const html = readFileSync(`${DOCS}/index.html`, "utf8");
  const { window: dom } = parseHTML(html);

  // Seed a saved job and deep-link straight to it, exactly as a reload would.
  store.set("gold-mobile-mechanic-phone-v1", JSON.stringify({
    version: 1,
    jobs: [{
      id: "GMM-0001", customerName: "deShaun O'Brien-Katz", customerPhone: "406 555 0147",
      customerEmail: "", vehicleYear: "2012", vehicleMake: "Chevrolet", vehicleModel: "Cruze",
      laborRateCents: 12000, status: "draft", materials: [], receipts: [], timeEntries: [],
      eventHistory: [], agreedWork: "Oil filter housing", createdAt: "2026-08-20T14:00:00.000Z",
      updatedAt: "2026-08-20T14:00:00.000Z"
    }]
  }));

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
    Blob: globalThis.Blob, FormData: globalThis.FormData, URL: globalThis.URL,
    Event: dom.Event, CustomEvent: dom.CustomEvent, Image: class {},
    document: dom.document,
    confirm: () => true, alert: () => {},
    fetch: async (url, options = {}) => {
      calls.push({ url: String(url), method: options.method || "GET", body: options.body });
      if (String(url).endsWith("/api/jobs")) {
        return new Response(JSON.stringify({ jobs: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ job: JSON.parse(options.body || "{}"), recorded: true }), { status: 200 });
    }
  };
  context.window = context;
  context.self = context;
  context.location = { hash: "#job/GMM-0001", origin: "https://thomasg42.github.io", pathname: "/gmm/index.html" };
  context.addEventListener = () => {};
  context.scrollTo = () => {};
  context.matchMedia = () => ({ matches: false, addEventListener() {} });


  vm.createContext(context);
  // sync-auth.js first: app.js calls through it for every cloud request.
  for (const file of ["sync-auth.js", "app.js"]) {
    vm.runInContext(readFileSync(`${DOCS}/${file}`, "utf8"), context, { filename: file });
  }

  // The app renders and syncs asynchronously, so wait for the condition rather
  // than for an arbitrary number of milliseconds.
  const settle = async (until) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      await new Promise((r) => setTimeout(r, 5));
      if (!until || until()) return;
    }
    if (until) throw new Error("timed out waiting for the app to settle");
  };
  await settle();

  const doc = dom.document;
  const state = () => JSON.parse(store.get("gold-mobile-mechanic-phone-v1") || '{"jobs":[]}');
  const job = () => state().jobs[0];
  const queuedEvents = () => JSON.parse(store.get("gold-mobile-mechanic-pending-events-v1") || "[]");
  const eventCalls = () => calls.filter((c) => c.url.includes("/events"));
  const timerButton = () => doc.querySelector("[data-timer-action]");
  const ok = () => {};

  assert.ok(doc.getElementById("jobView").innerHTML.includes("work order"), "job view rendered");
  ok("saved job opens straight to its work order");

  // No break control exists anywhere on the page.
  assert.doesNotMatch(doc.body.innerHTML, /break/i);
  ok("nothing on the job page mentions a break");

  // ------------------------------------------------------------------ clock in
  let button = timerButton();
  assert.equal(button.dataset.timerAction, "clock_in");
  assert.match(button.textContent, /Clock in/);
  button.dispatchEvent(new dom.Event("click"));
  await settle(() => job().status === "in_progress");

  assert.equal(job().status, "in_progress");
  let history = job().eventHistory;
  assert.deepEqual(history.map((e) => e.action), ["clock_in"]);
  ok("clock in starts the billable clock");

  // The event was written to storage and pushed on its own, immediately.
  assert.equal(eventCalls().length, 1);
  assert.equal(JSON.parse(eventCalls()[0].body).action, "clock_in");
  assert.equal(eventCalls()[0].method, "POST");
  ok("clock in posted its own event immediately, unbatched");

  // ----------------------------------------------------------------- clock out
  button = timerButton();
  assert.equal(button.dataset.timerAction, "clock_out");
  assert.match(button.textContent, /Clock out/);
  button.dispatchEvent(new dom.Event("click"));
  await settle(() => job().status === "clocked_out");

  assert.equal(job().status, "clocked_out");
  assert.deepEqual(job().eventHistory.map((e) => e.action), ["clock_in", "clock_out"]);
  assert.equal(eventCalls().length, 2);
  ok("clock out stops the clock and posts its own event");

  // Clocking out must NOT finish the job or file an invoice.
  assert.equal(job().invoice, undefined);
  assert.notEqual(job().status, "invoiced");
  ok("clocking out does not finish the job or file an invoice");

  // Billable time stopped: the open work span was closed.
  assert.equal(job().timeEntries.filter((e) => !e.endedAt).length, 0);
  ok("clocking out closes the billable span");

  // ------------------------------------------------------------ back and forth
  timerButton().dispatchEvent(new dom.Event("click"));   // clock in again
  await settle(() => job().status === "in_progress");
  timerButton().dispatchEvent(new dom.Event("click"));   // clock out again
  await settle(() => job().status === "clocked_out" && eventCalls().length === 4);
  assert.deepEqual(job().eventHistory.map((e) => e.action),
    ["clock_in", "clock_out", "clock_in", "clock_out"]);
  assert.equal(eventCalls().length, 4);
  const ids = new Set(job().eventHistory.map((e) => e.id));
  assert.equal(ids.size, 4);
  ok("every clock in and clock out is its own timestamped, separately posted event");

  // Each event carries the moment it was tapped, in order.
  const stamps = job().eventHistory.map((e) => Date.parse(e.occurredAt));
  assert.ok(stamps.every((t, i) => i === 0 || t >= stamps[i - 1]));
  assert.ok(stamps.every(Number.isFinite));
  ok("each event carries its own timestamp");

  // ---------------------------------------------------- offline durability
  calls.length = 0;
  context.navigator.onLine = false;
  timerButton().dispatchEvent(new dom.Event("click"));   // clock in, offline
  await settle(() => job().status === "in_progress");
  assert.equal(eventCalls().length, 0);
  assert.equal(queuedEvents().length, 1);               // held, not lost
  assert.equal(job().eventHistory.at(-1).action, "clock_in");
  ok("an offline clock in is still saved locally and queued");

  // Reloading the app offline must not lose the event.
  const reloaded = JSON.parse(store.get("gold-mobile-mechanic-phone-v1")).jobs[0];
  assert.equal(reloaded.eventHistory.length, 5);
  ok("the offline event survives a reload");


});
