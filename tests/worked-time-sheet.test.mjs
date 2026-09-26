/**
 * Drives docs/app.js as shipped, in a real DOM: the hand-written time sheet on
 * the job timer card.
 *
 * The thing being pinned here is the job Thomas actually described — he worked
 * and never touched the clock, so he types the date, the clock-in and the
 * clock-out, taps Done, and does it again for every span he worked. What is
 * saved this way is billable time on a customer's invoice, so the refusals
 * matter as much as the saves:
 *
 *  - Two spans that overlap would bill the same minutes twice.
 *  - A future clock-out would bill hours nobody has worked yet.
 *  - A removed span has to STAY removed: the cloud merges timeEntries as a
 *    union of ids, so a spliced row comes straight back on the next sync.
 *  - A second half-filled row must survive a Done on the row above it — the
 *    save re-renders the whole card.
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

/** A job that was never clocked into — exactly the case the sheet exists for. */
const SEED = {
  version: 1,
  jobs: [{
    id: "GMM-0042",
    customerName: "Renée Ostrowski-Baptiste",
    customerPhone: "406 555 0188",
    customerEmail: "",
    vehicleYear: "2009",
    vehicleMake: "Toyota",
    vehicleModel: "Tacoma",
    vehiclePlate: "",
    laborRateCents: 12000,
    status: "draft",
    materials: [],
    receipts: [],
    timeEntries: [],
    eventHistory: [],
    agreedWork: "Rear main seal",
    suggestions: "",
    createdAt: "2026-09-20T14:00:00.000Z",
    updatedAt: "2026-09-20T14:00:00.000Z"
  }]
};

function boot({ store, calls, confirmAnswer = () => true }) {
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
    navigator: { onLine: true },
    Headers: globalThis.Headers, Request: globalThis.Request, Response: globalThis.Response,
    Blob: globalThis.Blob, FormData: globalThis.FormData, URL: globalThis.URL,
    Event: dom.Event, CustomEvent: dom.CustomEvent, Image: class {},
    document: doc,
    confirm: (...args) => confirmAnswer(...args),
    alert: () => {},
    fetch: async (url, options = {}) => {
      const address = String(url);
      const method = options.method || "GET";
      calls.push({ url: address, method, body: options.body });
      if (address.endsWith("/api/jobs") && method === "GET") {
        return new Response(JSON.stringify({ jobs: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ job: JSON.parse(options.body || "{}"), recorded: true }), { status: 200 });
    }
  };
  context.window = context;
  context.self = context;
  context.location = { hash: "#job/GMM-0042", origin: "https://thomasg42.github.io", pathname: "/gmm/index.html" };
  context.addEventListener = () => {};
  context.scrollTo = () => {};
  context.matchMedia = () => ({ matches: false, addEventListener() {} });

  vm.createContext(context);
  for (const file of ["sync-auth.js", "app.js"]) {
    vm.runInContext(readFileSync(`${DOCS}/${file}`, "utf8"), context, { filename: file });
  }
  return { dom, doc, context };
}

const settle = async (until, label = "the app") => {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (!until || until()) return;
  }
  throw new Error(`timed out waiting for ${label}`);
};

/** YYYY-MM-DD for a day offset from today, in the phone's own timezone. */
function localDay(offsetDays = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  const pad = (part) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

test("a job worked off the clock is billed from hand-entered times", { skip: parseHTML ? false : "linkedom is not installed" }, async () => {
  const store = new Map([["gmm-sync-token", "test-device.signature"]]);
  const calls = [];
  let confirmAnswer = () => true;
  store.set("gold-mobile-mechanic-phone-v1", JSON.stringify(SEED));

  const { dom, doc } = boot({ store, calls, confirmAnswer: (...args) => confirmAnswer(...args) });
  await settle(() => doc.getElementById("timeSheet"));

  const state = () => JSON.parse(store.get("gold-mobile-mechanic-phone-v1") || '{"jobs":[]}');
  const job = () => state().jobs[0];
  const liveEntries = () => (job().timeEntries || []).filter((entry) => !entry.voided);
  const rows = () => [...doc.querySelectorAll("[data-entry-id], [data-draft-id]")];
  const click = (element) => element.dispatchEvent(new dom.Event("click"));
  const addRow = async () => {
    const before = rows().length;
    click(doc.getElementById("addWorkedTimeButton"));
    await settle(() => rows().length === before + 1, "the new row");
    return rows().at(-1);
  };
  const fill = (row, { date, start, end }) => {
    if (date !== undefined) row.querySelector("[data-session-date]").value = date;
    if (start !== undefined) row.querySelector("[data-session-start]").value = start;
    if (end !== undefined) row.querySelector("[data-session-end]").value = end;
  };
  const done = (row) => click(row.querySelector("[data-session-done]"));
  const toast = () => doc.getElementById("toast")?.textContent || "";

  // ------------------------------------------------- the sheet is on the page
  assert.equal(job().status, "draft");
  assert.match(doc.getElementById("timeSheet").textContent, /Times you worked/);
  assert.equal(rows().length, 0, "nothing is offered as worked time until he adds it");

  // ------------------------------------------------------- one span, by hand
  let row = await addRow();
  fill(row, { date: localDay(-1), start: "08:00", end: "12:00" });
  done(row);
  await settle(() => liveEntries().length === 1, "the first saved span");

  assert.equal(liveEntries().length, 1);
  assert.equal(liveEntries()[0].kind, "work");
  assert.equal(
    Date.parse(liveEntries()[0].endedAt) - Date.parse(liveEntries()[0].startedAt),
    4 * 60 * 60 * 1000,
    "four hours worked is four hours billed"
  );
  // Hand-entered work takes the job off the clock, which is what enables
  // Finish Project — it is not a draft any more.
  assert.equal(job().status, "clocked_out");
  assert.equal(job().startedAt, liveEntries()[0].startedAt, "the invoice's clock-in follows the earliest span");
  assert.match(doc.getElementById("liveWorkTimer").textContent, /^04:00/);

  // The trail says it was typed, never that a button was tapped.
  const added = job().eventHistory.filter((event) => event.action === "time_added");
  assert.equal(added.length, 1);
  assert.match(doc.getElementById("jobView").innerHTML, /Worked time added by hand/);
  assert.doesNotMatch(
    job().eventHistory.map((event) => event.action).join(","),
    /clock_in|clock_out/,
    "a hand entry never fabricates a clock tap"
  );

  // A hand entry is NOT posted to the clock-event endpoint: that route accepts
  // clock_in and clock_out only and would reject it with a 400.
  assert.equal(calls.filter((call) => call.url.includes("/events")).length, 0);
  assert.ok(calls.some((call) => /\/api\/jobs\/GMM-0042$/.test(call.url) && call.method === "PUT"),
    "the job itself was pushed");

  // ---------------------------------------- a second row survives the first
  const rowA = await addRow();
  fill(rowA, { date: localDay(-1), start: "13:00", end: "15:00" });
  const rowB = await addRow();
  fill(rowB, { date: localDay(-2), start: "09:00", end: "10:30" });
  // Saving the second one re-renders the whole card. The first one's typed
  // values have to come back with it, or the row he filled in is silently gone.
  done(rowB);
  await settle(() => liveEntries().length === 2, "the second saved span");

  const stillTyped = rows().find((item) => item.dataset.draftId);
  assert.ok(stillTyped, "the unsaved row is still on screen");
  assert.equal(stillTyped.querySelector("[data-session-start]").value, "13:00");
  assert.equal(stillTyped.querySelector("[data-session-end]").value, "15:00");

  // Half-corrected saved rows survive the same re-render. Nothing here is
  // billed — it still takes that row's own Done — but it is not thrown away.
  const savedRows = [...doc.querySelectorAll("[data-entry-id]")];
  const correctingId = savedRows[0].dataset.entryId;
  const originalStart = savedRows[0].querySelector("[data-session-start]").value;
  savedRows[0].querySelector("[data-session-start]").value = "07:15";

  done(stillTyped);
  await settle(() => liveEntries().length === 3, "the third saved span");
  assert.equal(doc.querySelectorAll("[data-draft-id]").length, 0, "a saved row stops being a draft");
  assert.equal(
    doc.querySelector(`[data-entry-id="${correctingId}"] [data-session-start]`).value,
    "07:15",
    "a correction typed into another row is still there after the save re-renders"
  );
  assert.notEqual(
    new Date(liveEntries().find((entry) => entry.id === correctingId).startedAt).getHours(),
    7,
    "and it is NOT billed until that row's own Done is tapped"
  );
  // Put it back, so the row is genuinely unchanged for the check below and the
  // spans that follow are measured against the times actually saved.
  doc.querySelector(`[data-entry-id="${correctingId}"] [data-session-start]`).value = originalStart;
  // 4h + 1h30 + 2h.
  assert.match(doc.getElementById("liveWorkTimer").textContent, /^07:30/);

  // A Done on a row he did not touch is not a correction, and must not file one.
  const auditBefore = job().eventHistory.length;
  done(doc.querySelector(`[data-entry-id="${correctingId}"]`));
  await settle(() => /already saved/i.test(toast()), "the no-change reply");
  assert.equal(job().eventHistory.length, auditBefore,
    "an unchanged row writes no audit entry");
  // The billable total has not moved either — 4h + 1h30 + 2h, still.
  assert.match(doc.getElementById("liveWorkTimer").textContent, /^07:30/);

  // ------------------------------------------------------------- refusals
  const beforeOverlap = liveEntries().length;
  row = await addRow();
  fill(row, { date: localDay(-1), start: "09:00", end: "10:00" });
  done(row);
  await settle(() => /overlaps/i.test(toast()), "the overlap refusal");
  assert.equal(liveEntries().length, beforeOverlap, "an overlapping span is never written");

  fill(row, { date: localDay(1), start: "08:00", end: "09:00" });
  done(row);
  await settle(() => /future/i.test(toast()), "the future refusal");
  assert.equal(liveEntries().length, beforeOverlap, "tomorrow's hours are never written");

  fill(row, { date: localDay(-3), start: "08:00", end: "" });
  done(row);
  await settle(() => /clock-out time/i.test(toast()), "the missing clock-out refusal");
  assert.equal(liveEntries().length, beforeOverlap);

  // ------------------------------------------------- a shift past midnight
  fill(row, { date: localDay(-4), start: "22:00", end: "01:00" });
  done(row);
  await settle(() => liveEntries().length === beforeOverlap + 1, "the overnight span");
  const overnight = liveEntries().find((entry) => entry.startedAt.includes("T") &&
    Date.parse(entry.endedAt) - Date.parse(entry.startedAt) === 3 * 60 * 60 * 1000);
  assert.ok(overnight, "10 PM to 1 AM is a three-hour night, not a rejected typo");
  assert.match(toast(), /next day/);

  // ------------------------------------------------------ removing a span
  const target = [...doc.querySelectorAll("[data-entry-id]")][0];
  const targetId = target.dataset.entryId;
  const beforeRemove = liveEntries().length;
  confirmAnswer = () => false;
  click(target.querySelector("[data-session-remove]"));
  await settle(() => true);
  assert.equal(liveEntries().length, beforeRemove, "a declined confirm removes nothing");

  confirmAnswer = () => true;
  click(doc.querySelector(`[data-entry-id="${targetId}"] [data-session-remove]`));
  await settle(() => liveEntries().length === beforeRemove - 1, "the removal");

  const tombstone = (job().timeEntries || []).find((entry) => entry.id === targetId);
  assert.ok(tombstone, "the row is tombstoned, not spliced — a union merge would hand a deleted row back");
  assert.equal(tombstone.voided, true);
  assert.match(job().eventHistory.map((event) => event.action).join(","), /time_removed/);
});

test("the running span can be corrected but not removed, and Anya writes through the same path", { skip: parseHTML ? false : "linkedom is not installed" }, async () => {
  const store = new Map([["gmm-sync-token", "test-device.signature"]]);
  const calls = [];
  store.set("gold-mobile-mechanic-phone-v1", JSON.stringify(SEED));

  const { dom, doc, context } = boot({ store, calls });
  await settle(() => doc.getElementById("timeSheet"));

  const state = () => JSON.parse(store.get("gold-mobile-mechanic-phone-v1") || '{"jobs":[]}');
  const job = () => state().jobs[0];
  const liveEntries = () => (job().timeEntries || []).filter((entry) => !entry.voided);
  const click = (element) => element.dispatchEvent(new dom.Event("click"));

  // Clock in for real, so one span is open.
  click(doc.querySelector('[data-timer-action="clock_in"]'));
  await settle(() => job().status === "in_progress", "the clock to start");

  const running = doc.querySelector("[data-entry-id]");
  assert.match(running.textContent, /On the clock now/);
  assert.equal(running.querySelector("[data-session-remove]"), null,
    "the span he is standing in cannot be removed out from under him");
  assert.ok(running.querySelector("[data-session-start]"), "its start is still correctable");

  // He started an hour before he remembered to tap it.
  const startedAt = new Date(Date.now() - 60 * 60 * 1000);
  const pad = (part) => String(part).padStart(2, "0");
  running.querySelector("[data-session-date]").value =
    `${startedAt.getFullYear()}-${pad(startedAt.getMonth() + 1)}-${pad(startedAt.getDate())}`;
  running.querySelector("[data-session-start]").value =
    `${pad(startedAt.getHours())}:${pad(startedAt.getMinutes())}`;
  click(running.querySelector("[data-session-done]"));
  await settle(() => Date.now() - Date.parse(liveEntries()[0].startedAt) > 59 * 60 * 1000, "the corrected start");

  assert.equal(liveEntries().length, 1, "correcting a start never creates a second span");
  assert.equal(liveEntries()[0].endedAt, null, "the clock is still running");
  assert.equal(job().status, "in_progress");

  // ------------------------------------------------------------ Anya's tool
  const bridge = context.window.GMMAgentBridge;
  const yesterday = localDay(-1);
  const spoken = bridge.runAction("log_worked_time", { date: yesterday, start: "08:00", end: "12:00" });
  assert.equal(spoken.ok, true, spoken.message);
  await settle(() => liveEntries().length === 2, "Anya's span");
  assert.match(spoken.message, /4h 00m/);

  // She refuses exactly where the button refuses, and says so rather than
  // reporting a save that never happened.
  const clash = bridge.runAction("log_worked_time", { date: yesterday, start: "09:00", end: "10:00" });
  assert.equal(clash.ok, false);
  assert.match(clash.message, /overlaps/i);
  assert.equal(liveEntries().length, 2, "a refused tool call writes nothing");

  const guessed = bridge.runAction("log_worked_time", { date: "", start: "08:00", end: "12:00" });
  assert.equal(guessed.ok, false);
  assert.match(guessed.message, /date/i);

  // The phone's own calendar day goes up with the context, not the Worker's
  // UTC one — the edge is already on tomorrow by late afternoon in Montana.
  assert.equal(bridge.jobContext().today, localDay(0));
});
