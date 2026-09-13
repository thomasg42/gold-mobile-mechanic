/**
 * Drives the shipped docs/voice.js + docs/assistant.js + docs/app.js through a
 * whole Talk it in conversation in a real DOM, with a scripted speech
 * recogniser standing in for the phone's and the Worker's agent route stubbed.
 *
 * Two defects are pinned here, both reported from the driveway, and both still
 * live after the scripted new-job interview was replaced by the shop agent —
 * because the agent listens through the same `GMMVoice` turn:
 *
 *  1. THE CUT-OFF. The browser recogniser ends the turn at the first gap, so
 *     listing the work on a truck — which has thinking pauses in it — filed
 *     half a sentence and moved on. The recorded turn is owned by the app: an
 *     `onend` inside the patience window restarts the recogniser and keeps
 *     appending, and only real silence ends the answer. The agent asks its
 *     open questions with `listen("long")`, so half an answer reaching the
 *     model is the same defect wearing a new hat — and worse, because the
 *     model would confidently write the half it got onto the invoice.
 *
 *  2. "NOT CORRECT" MEANT YES. The negative pattern never matched the phrase,
 *     and the affirmative one matched the word "correct" sitting inside it, so
 *     rejecting a read-back confirmed it instead. The agent runs the same
 *     `parse.yesNo` on its final read-back, where a false yes does not just
 *     mis-file a field — it saves the whole job.
 *
 * The third defect this file used to pin — a "no" re-asking a whole section
 * instead of the named step — was a property of the scripted step runner. That
 * runner still exists and still serves the receipt and closeout interviews, but
 * opening a job no longer goes through it, so it is no longer exercised
 * end-to-end here. Corrections during Talk it in are handled by the model.
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

function boot({ turns, clock, spoken, transcripts, cloud, calls, agentReplies }) {
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
        // No ElevenLabs key: the phone's own recogniser is what runs. The agent
        // is configured, so Talk it in is visible.
        return new Response(JSON.stringify({ voice: false, assistant: true }), { status: 200 });
      }
      if (address.endsWith("/api/assistant/invoice")) {
        const sent = JSON.parse(options.body);
        const reply = agentReplies.shift();
        // The stub echoes the mechanic's last words straight back as the work
        // description. That is the point: whatever the recogniser handed the
        // agent is what ends up on the invoice, so a truncated turn shows up
        // in the saved job rather than being smoothed over by a fake answer.
        const lastHeard = [...sent.messages].reverse().find((m) => m.role === "user")?.content || "";
        if (reply.echoWorkFromSpeech) reply.fields.agreedWork = lastHeard;
        return new Response(JSON.stringify(reply), { status: 200 });
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
  for (const file of ["voice-config.js", "voice.js", "assistant.js", "app.js"]) {
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

test("Talk it in waits out a long pause and takes 'not correct' as a no", {
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
    // The long answer, with a five-second thinking pause in the middle of it.
    { chunks: [
      { at: 400, text: "replace the oil filter housing" },
      { at: 900, text: "and the thermostat" },
      { at: 6400, text: "and flush the coolant" }
    ] },                                      // 0  the work          <-- bug 1
    say("that is not correct"),               // 1  read-back         <-- bug 2
    say("yes")                                // 2  read-back, agreed
  ];

  const readBack = "Jane Rivera, 2014 Chevrolet Cruze, one twenty five an hour. Right?";
  const agentReplies = [
    { say: "What are we doing to it?",
      fields: { customerName: "Jane Rivera", vehicleYear: "2014", vehicleMake: "Chevrolet", vehicleModel: "Cruze" },
      materials: [], ready: false, missing: ["agreedWork"] },
    { say: readBack, fields: { laborRate: "125" }, materials: [], ready: true, missing: [],
      echoWorkFromSpeech: true },
    { say: readBack, fields: {}, materials: [], ready: true, missing: [] }
  ];

  const { dom, context, store } = boot({ turns, clock, spoken, transcripts, cloud, calls, agentReplies });
  const doc = dom.document;

  try {
    await settle(() => calls.some((call) => call.url.endsWith("/api/jobs")), "the cloud ledger");

    // ---------------------------------------------------------------- bug 2
    // Asserted on the parser directly as well as through the save below: this
    // is the phrase that used to confirm a read-back it was rejecting.
    assert.equal(context.GMMVoice.parse.yesNo("that is not correct"), false);
    assert.equal(context.GMMVoice.parse.yesNo("yes"), true);

    await settle(() => !doc.getElementById("talkRow").classList.contains("hidden"), "the Talk it in button");
    doc.getElementById("newJobButton").dispatchEvent(new dom.Event("click"));
    await settle(() => doc.getElementById("jobDialog").open, "the invoice sheet");
    doc.getElementById("talkItInButton").dispatchEvent(new dom.Event("click"));

    const state = () => JSON.parse(store.get("gold-mobile-mechanic-phone-v1") || '{"jobs":[]}');
    await settle(() => state().jobs.length === 1, "the job to be created by the agent");
    const job = state().jobs[0];

    // ---------------------------------------------------------------- bug 1
    assert.equal(
      job.agreedWork,
      "replace the oil filter housing and the thermostat and flush the coolant",
      "a five-second pause mid-answer must not end the answer"
    );

    // ---------------------------------------------------------------- bug 2
    // The read-back was spoken twice: the first "that is not correct" must have
    // been heard as a rejection, so nothing was saved on that pass.
    assert.equal(
      spoken.filter((line) => line === readBack).length,
      2,
      "'not correct' was heard as a rejection, so the agent asked again"
    );
    assert.equal(agentReplies.length, 0, "every scripted agent turn was used");

    // The rest of the work order still came through.
    assert.equal(job.customerName, "Jane Rivera");
    assert.equal(job.vehicleYear, "2014");
    assert.equal(job.vehicleMake, "Chevrolet");
    assert.equal(job.vehicleModel, "Cruze");
    assert.equal(job.laborRateCents, 12500);
    assert.equal(job.status, "draft");
  } finally {
    clearInterval(ticker);
  }
});
