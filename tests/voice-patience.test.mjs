/**
 * Drives the shipped docs/voice.js + docs/voice-config.js + docs/app.js through
 * a whole "New job by voice" interview in a real DOM, with a scripted speech
 * recogniser standing in for the phone's.
 *
 * Three defects are pinned here, all reported from the driveway:
 *
 *  1. THE CUT-OFF. The browser recogniser ends the turn at the first gap, so
 *     listing the work on a truck — which has thinking pauses in it — filed
 *     half a sentence and moved on. The recorded turn is now owned by the app:
 *     an `onend` inside the patience window restarts the recogniser and keeps
 *     appending, and only real silence ends the answer.
 *
 *  2. "NOT CORRECT" MEANT YES. The negative pattern never matched the phrase,
 *     and the affirmative one matched the word "correct" sitting inside it, so
 *     rejecting a read-back confirmed it instead.
 *
 *  3. A "no" THREW AWAY THE WHOLE SECTION. Correcting one digit of a phone
 *     number re-asked the name and the email too. Only the named step is
 *     re-asked now.
 *
 * The plate question is also gone from the interview — Thomas does not want to
 * be asked for it — while the plate itself stays an editable field on the job.
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

/**
 * A scripted stand-in for webkitSpeechRecognition.
 *
 * It behaves like the real thing in the way that matters: it hands back a
 * result per phrase and then gives up on its own after a short quiet spell,
 * exactly as iOS does. Surviving that give-up is the fix under test.
 *
 * A turn ends only when the app calls `stop()` — that is the app deciding the
 * answer is over, which is the decision this whole change moves out of the
 * recogniser and into `listenWithBrowser`.
 */
function scriptedRecognition({ turns, clock, transcripts }) {
  let turnIndex = 0;
  let turnStart = null;
  let fired = 0;

  class FakeRecognition {
    constructor() {
      this.ended = false;
      this.timer = null;
      this.lastAt = null;
    }

    start() {
      if (turnStart === null) {
        turnStart = clock.now;
        fired = 0;
        this.lastAt = null;
      }
      this.timer = setInterval(() => this.tick(), 4);
      this.timer.unref?.();
    }

    tick() {
      if (this.ended) return;
      const turn = turns[turnIndex] || { chunks: [] };
      const elapsed = clock.now - turnStart;
      if (fired < turn.chunks.length && elapsed >= turn.chunks[fired].at) {
        const chunk = turn.chunks[fired];
        fired += 1;
        this.lastAt = clock.now;
        const result = [{ transcript: chunk.text }];
        result.isFinal = true;
        this.onresult?.({ resultIndex: 0, results: [result] });
        return;
      }
      // The real recogniser hangs up on its own after a short pause. The app
      // must treat that as "still waiting", not as "they finished talking".
      if (clock.now - (this.lastAt ?? turnStart) > 1500) this.giveUp();
    }

    /** What iOS does unprompted: end the turn early. */
    giveUp() {
      if (this.ended) return;
      this.ended = true;
      clearInterval(this.timer);
      this.onend?.();
    }

    /** Only the app calls this, and only when it has decided the turn is over. */
    stop() {
      if (!this.ended) {
        this.ended = true;
        clearInterval(this.timer);
      }
      if (turnStart !== null) {
        transcripts.push(turnIndex);
        turnIndex += 1;
        turnStart = null;
      }
      this.onend?.();
    }
  }

  return { FakeRecognition, turnsUsed: () => turnIndex };
}

function boot({ turns, clock, spoken, transcripts, cloud, calls }) {
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
  // Patched on the prototype, not the instances: the voice panel builds its own
  // <dialog> at runtime and it has to be modal too, or it lands under the sheet.
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

  class FakeDate extends Date {
    static now() { return clock.now; }
  }

  const { FakeRecognition } = scriptedRecognition({ turns, clock, transcripts });
  const store = new Map();

  // Unref'd so a recogniser or watchdog still ticking when the interview ends
  // cannot hold the test process open after the assertions have run.
  const keepAlive = (fn, ms) => {
    const timer = setInterval(fn, ms);
    timer.unref?.();
    return timer;
  };

  const context = {
    console, setTimeout, clearTimeout, clearInterval, queueMicrotask,
    setInterval: keepAlive,
    Date: FakeDate,
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
    Audio: class {
      setAttribute() {}
      play() { return Promise.resolve(); }
      pause() {}
      load() {}
    },
    document: doc,
    confirm: () => true,
    alert: () => {},
    webkitSpeechRecognition: FakeRecognition,
    // No speechSynthesis object would make speak() a no-op, and the questions
    // it asks are half of what this test is checking.
    SpeechSynthesisUtterance: class {
      constructor(text) { this.text = text; }
    },
    speechSynthesis: {
      cancel() {},
      speak(utterance) {
        spoken.push(String(utterance.text));
        setTimeout(() => utterance.onend?.(), 0);
      }
    },
    fetch: async (url, options = {}) => {
      const address = String(url);
      const method = options.method || "GET";
      calls.push({ url: address, method });
      if (address.endsWith("/api/health")) {
        // No ElevenLabs key: the phone's own recogniser is what runs.
        return new Response(JSON.stringify({ voice: false }), { status: 200 });
      }
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
  for (const file of ["voice-config.js", "voice.js", "app.js"]) {
    vm.runInContext(readFileSync(`${DOCS}/${file}`, "utf8"), context, { filename: file });
  }
  return { dom, context, store };
}

const settle = async (until, label = "the interview") => {
  for (let attempt = 0; attempt < 4000; attempt += 1) {
    await new Promise((r) => setTimeout(r, 4));
    if (until()) return;
  }
  throw new Error(`timed out waiting for ${label}`);
};

test("the voice interview waits out a long pause, takes 'not correct' as a no, and fixes only the part that was wrong", {
  skip: parseHTML ? false : "linkedom is not installed"
}, async () => {
  const clock = { now: Date.parse("2026-08-25T15:00:00.000Z") };
  // 10x wall-clock, so a seven-second thinking pause costs the test 700ms.
  const ticker = setInterval(() => { clock.now += 50; }, 5);
  ticker.unref?.();

  const spoken = [];
  const transcripts = [];
  const cloud = new Map();
  const calls = [];

  const say = (...phrases) => ({
    chunks: phrases.map((text, index) => ({ at: 400 + index * 400, text }))
  });

  const turns = [
    say("Jane Rivera"),                       // 0  whose car
    say("yes"),                               // 1  spelling read-back
    say("406 555 0101"),                      // 2  phone
    say("yes"),                               // 3  phone read-back
    say("skip"),                              // 4  email
    say("that is not correct"),               // 5  section read-back  <-- bug 2
    say("the phone number is wrong"),         // 6  which part         <-- bug 3
    say("406 555 0199"),                      // 7  phone again
    say("yes"),                               // 8  phone read-back
    say("yes"),                               // 9  section read-back
    say("a 2014 Chevrolet Cruze"),            // 10 vehicle (no plate question)
    say("yes"),                               // 11 vehicle read-back
    // The long answer, with a five-second thinking pause in the middle of it.
    { chunks: [
      { at: 400, text: "replace the oil filter housing" },
      { at: 900, text: "and the thermostat" },
      { at: 6400, text: "and flush the coolant" }
    ] },                                      // 12 the work           <-- bug 1
    say("one twenty five"),                   // 13 labor rate
    say("yes"),                               // 14 section read-back
    say("skip"),                              // 15 materials
    say("yes"),                               // 16 section read-back
    say("no")                                 // 17 clock in?
  ];

  const { dom, store } = boot({ turns, clock, spoken, transcripts, cloud, calls });
  const doc = dom.document;

  try {
    await settle(() => calls.some((call) => call.url.endsWith("/api/jobs")), "the cloud ledger");
    doc.getElementById("voiceNewJobButton").dispatchEvent(new dom.Event("click"));

    const state = () => JSON.parse(store.get("gold-mobile-mechanic-phone-v1") || '{"jobs":[]}');
    await settle(() => state().jobs.length === 1, "the job to be created by voice");
    const job = state().jobs[0];

    // ---------------------------------------------------------------- bug 1
    assert.equal(
      job.agreedWork,
      // Sentence-cased by the parser, as any dictated answer is.
      "Replace the oil filter housing and the thermostat and flush the coolant",
      "a five-second pause mid-answer must not end the answer"
    );

    // ---------------------------------------------------------------- bug 2
    const asked = spoken.join(" | ");
    assert.match(asked, /Which part should I fix/, "'not correct' was heard as a rejection");

    // ---------------------------------------------------------------- bug 3
    assert.equal(job.customerPhone, "406 555 0199", "the corrected number is what was saved");
    const nameAsks = spoken.filter((line) => /Whose car are we working on/.test(line)).length;
    assert.equal(nameAsks, 1, "fixing the phone number must not re-ask the customer name");
    const emailAsks = spoken.filter((line) => /email/i.test(line) && /skip/i.test(line)).length;
    assert.equal(emailAsks, 1, "fixing the phone number must not re-ask the email");
    assert.equal(job.customerName, "Jane Rivera");

    // ------------------------------------------- the plate is no longer asked
    assert.equal(
      spoken.filter((line) => /plate/i.test(line)).length,
      0,
      "the interview no longer asks for a plate"
    );

    // The rest of the work order still came through.
    assert.equal(job.vehicleYear, "2014");
    assert.equal(job.vehicleMake, "Chevrolet");
    assert.equal(job.vehicleModel, "Cruze");
    assert.equal(job.laborRateCents, 12500);
    assert.equal(job.status, "draft", "answering 'no' to clock in leaves the timer stopped");
  } finally {
    clearInterval(ticker);
  }
});
