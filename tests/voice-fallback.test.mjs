/**
 * The reported bug: "when you hit talk, it doesn't listen or anything — it
 * just counts down seconds, and then nothing."
 *
 * The cause was not the microphone and not Anya. `/api/health` reports whether
 * an ElevenLabs key is SET, not whether it WORKS. The key on the live Worker
 * had stopped working — every call came back 502 — so the app picked the
 * hosted recogniser, recorded a perfectly good clip, sent it, got a refusal,
 * and returned "" for the turn. Two separate things then conspired to make
 * that silent and permanent:
 *
 *   1. The fallback was guarded by `engine !== "elevenlabs"`, which is false in
 *      exactly the situation the fallback exists for. The phone's own
 *      recogniser — sitting right there, working fine — was never called.
 *
 *   2. The one path that did downgrade (a 503) set the `engine` variable but
 *      not the memoised answer `detectEngine()` hands out, so the downgrade
 *      never took effect on the next turn either.
 *
 * Net effect: the talk button recorded, showed its "take your time" counter,
 * and then did nothing, forever, with no error shown anywhere.
 *
 * These assertions drive the SHIPPED docs/voice.js through the real recording
 * path with a failing transcriber, and require that the words still arrive.
 *
 * The last two tests share this file's browser harness rather than standing up
 * a second one. They cover device pairing, which is the other half of what
 * `/api/voice/*` needs to work now that those routes sit behind the operator
 * gate — and which is what keeps a phone alive through the deploy that locks
 * the Worker.
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

/** Speaks one phrase, then falls quiet, the way the real one does. */
function scriptedRecognition(phrases) {
  let index = 0;
  return class FakeRecognition {
    start() {
      this.timer = setInterval(() => {
        if (this.ended) return;
        const phrase = phrases[index];
        if (phrase === undefined) return;
        index += 1;
        const result = [{ transcript: phrase }];
        result.isFinal = true;
        this.onresult?.({ resultIndex: 0, results: [result] });
      }, 6);
      this.timer.unref?.();
    }
    stop() {
      this.ended = true;
      clearInterval(this.timer);
      this.onend?.();
    }
  };
}

/**
 * A microphone that hears a real utterance and then goes quiet.
 *
 * The levels matter: `recordUtterance` only shows its countdown, and only ends
 * the turn on a silence boundary, once it has actually detected speech. A
 * stub that reported silence throughout would take a different branch out of
 * the loop and would not reproduce the reported symptom at all.
 */
function fakeAudio(clock) {
  let started = 0;
  // Generous against the accelerated clock below: the recorder samples every
  // 90ms of REAL time, so too short a window here is never sampled while loud
  // and the clip comes back marked as silence.
  const SPEECH_MS = 5000;
  return {
    AudioContext: class {
      constructor() { this.state = "running"; }
      resume() { return Promise.resolve(); }
      createAnalyser() {
        return {
          fftSize: 1024,
          getByteTimeDomainData(samples) {
            const loud = clock.now - started < SPEECH_MS;
            for (let i = 0; i < samples.length; i += 1) {
              samples[i] = loud ? 128 + (i % 2 ? 40 : -40) : 128;
            }
          },
          disconnect() {}
        };
      }
      createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    },
    MediaRecorder: class {
      static isTypeSupported() { return true; }
      constructor() { this.state = "inactive"; this.mimeType = "audio/webm"; }
      start() { this.state = "recording"; started = clock.now; }
      stop() {
        this.state = "inactive";
        // A REAL Blob, and comfortably over the 1200-byte floor that
        // `listenWithElevenLabs` uses to discard an empty clip. A stub that
        // returns a plain object produces a 15-byte blob, the clip is dropped
        // as silence, and the transcriber under test is never called at all.
        this.ondataavailable?.({ data: new Blob([new Uint8Array(4096)]) });
        this.onstop?.();
      }
    },
    stream: { getTracks: () => [{ stop() {} }] }
  };
}

function boot({ clock, phrases, fetchImpl, spoken }) {
  const { window: dom } = parseHTML(readFileSync(`${DOCS}/index.html`, "utf8"));
  const doc = dom.document;
  const dialogProto = Object.getPrototypeOf(doc.querySelector("dialog"));
  dialogProto.showModal = function showModal() { this.setAttribute("open", ""); this.open = true; };
  dialogProto.close = function close() { this.removeAttribute("open"); this.open = false; };

  const audio = fakeAudio(clock);
  const store = new Map([["gmm-sync-token", "test-device.signature"]]);
  const keepAlive = (fn, ms) => { const t = setInterval(fn, ms); t.unref?.(); return t; };

  const context = {
    console, setTimeout, clearTimeout, clearInterval, queueMicrotask,
    setInterval: keepAlive,
    Date: class extends Date { static now() { return clock.now; } },
    crypto: { randomUUID: () => "test-device" },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k)
    },
    navigator: {
      onLine: true,
      mediaDevices: { getUserMedia: async () => audio.stream }
    },
    Headers: globalThis.Headers, Request: globalThis.Request, Response: globalThis.Response,
    Blob: globalThis.Blob, URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} },
    Event: dom.Event, CustomEvent: dom.CustomEvent, Image: class {},
    AudioContext: audio.AudioContext,
    MediaRecorder: audio.MediaRecorder,
    Audio: class { setAttribute() {} play() { return Promise.resolve(); } pause() {} load() {} },
    document: doc,
    confirm: () => true,
    alert: () => {},
    prompt: () => null,
    webkitSpeechRecognition: scriptedRecognition(phrases),
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    speechSynthesis: {
      cancel() {},
      speak(u) { spoken.push(String(u.text)); setTimeout(() => u.onend?.(), 0); }
    },
    fetch: fetchImpl
  };
  context.window = context;
  context.self = context;
  context.location = { hash: "", origin: "https://thomasg42.github.io", pathname: "/gmm/index.html" };
  context.addEventListener = () => {};
  context.matchMedia = () => ({ matches: false, addEventListener() {} });

  vm.createContext(context);
  for (const file of ["sync-auth.js", "voice-config.js", "voice.js"]) {
    vm.runInContext(readFileSync(`${DOCS}/${file}`, "utf8"), context, { filename: file });
  }
  return { context, doc };
}

test("a dead ElevenLabs key falls through to the phone's own recogniser", {
  skip: parseHTML ? false : "linkedom is not installed"
}, async () => {
  const clock = { now: Date.parse("2026-09-12T15:00:00.000Z") };
  const ticker = setInterval(() => { clock.now += 60; }, 4);
  ticker.unref?.();

  const calls = [];
  const spoken = [];
  const fetchImpl = async (url) => {
    const address = String(url);
    calls.push(address);
    if (address.endsWith("/api/health")) {
      // The exact live state: a key IS set, so the app picks the hosted engine.
      return new Response(JSON.stringify({ voice: true, assistant: true, locked: true }), { status: 200 });
    }
    // ...and the key no longer works. This is what the live Worker returns.
    if (address.includes("/api/voice/")) {
      return new Response(JSON.stringify({ error: "Voice service is unavailable." }), { status: 502 });
    }
    return new Response("{}", { status: 200 });
  };

  const { context, doc } = boot({
    clock, phrases: ["replace the front brakes"], fetchImpl, spoken
  });

  const heard = [];
  const run = context.window.GMMVoice.run(async ({ listen }) => {
    heard.push(await listen("long"));
    heard.push(await listen("long"));
    return "done";
  });

  const finished = await Promise.race([
    run,
    new Promise((_, reject) => setTimeout(() => reject(new Error("voice run never finished")), 15000))
  ]);

  assert.equal(finished.ok, true, "the run must complete rather than hang");

  // THE REGRESSION. Before the fix this was "" — recorded, counted down, and
  // returned nothing, which is precisely what "it doesn't listen" looked like.
  assert.equal(heard[0], "replace the front brakes",
    "a failing hosted transcriber must hand the turn to the phone's recogniser");

  const sttCalls = calls.filter((url) => url.includes("/api/voice/stt"));
  assert.equal(sttCalls.length, 1,
    "after one hard failure the app must stop calling the dead service every turn");

  assert.match(doc.getElementById("voiceNotice").textContent, /phone/i,
    "and must say on screen why the voice changed under him");
});

test("a turn that hears nothing opens the keyboard instead of asking again", {
  skip: parseHTML ? false : "linkedom is not installed"
}, async () => {
  const clock = { now: Date.parse("2026-09-12T15:00:00.000Z") };
  const ticker = setInterval(() => { clock.now += 60; }, 4);
  ticker.unref?.();

  const spoken = [];
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/api/health")) {
      return new Response(JSON.stringify({ voice: false, assistant: true }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  };

  // No phrases at all: the recogniser hears nothing the whole turn.
  const { context, doc } = boot({ clock, phrases: [], fetchImpl, spoken });

  // Read while the panel is still up: `run` hides and resets the overlay on the
  // way out, so asserting afterwards would only ever see the cleaned-up state.
  let typedRowHiddenAfterTurn = null;
  const result = await Promise.race([
    context.window.GMMVoice.run(async ({ listen }) => {
      const heard = await listen("normal");
      typedRowHiddenAfterTurn = doc.getElementById("voiceTypedRow").className.includes("hidden");
      return heard;
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("voice run never finished")), 15000))
  ]);

  assert.equal(result.ok, true);
  assert.equal(result.result, "", "nothing was said, so nothing is heard");
  // "Type instead" was always present, behind a button — no help when the
  // symptom is that nothing visibly happens. A dead turn now opens it.
  assert.equal(typedRowHiddenAfterTurn, false,
    "a turn that came back empty must put the keyboard in front of him");
});

test("a phone meeting a newly locked Worker pairs itself and replays the call", {
  skip: parseHTML ? false : "linkedom is not installed"
}, async () => {
  // This is the deploy path. The Worker gets locked while phones in the field
  // are still mid-session; without this, every one of them goes dead until
  // someone reinstalls the app. The 401 has to be a prompt, not an error.
  const clock = { now: Date.parse("2026-09-12T15:00:00.000Z") };
  const seen = [];
  let locked = true;

  const fetchImpl = async (url, options = {}) => {
    const address = String(url);
    const auth = new Headers(options.headers || {}).get("Authorization") || "";
    seen.push({ path: address.replace(/^https?:\/\/[^/]+/, ""), auth });

    if (address.endsWith("/api/pair")) {
      const { pin } = JSON.parse(options.body);
      if (pin !== "406117") return new Response(JSON.stringify({ error: "nope" }), { status: 401 });
      return new Response(JSON.stringify({ token: "phone-1.goodsignature" }), { status: 200 });
    }
    if (locked && auth !== "Bearer phone-1.goodsignature") {
      return new Response(JSON.stringify({ error: "Pair this device to use the app." }), { status: 401 });
    }
    return new Response(JSON.stringify({ jobs: [] }), { status: 200 });
  };

  const { context } = boot({ clock, phrases: [], fetchImpl, spoken: [] });
  // Start UNPAIRED, the way a phone in the field is the moment the gate lands.
  context.localStorage.removeItem("gmm-sync-token");
  context.prompt = () => "406117";

  const response = await context.window.GMMAuth.request("/api/jobs");
  assert.equal(response.status, 200, "the call must succeed after pairing itself");

  assert.deepEqual(seen.map((call) => call.path), ["/api/jobs", "/api/pair", "/api/jobs"],
    "first call unauthenticated, then pair, then the SAME call replayed");
  assert.equal(seen[0].auth, "", "nothing to send on the first try");
  assert.equal(seen[2].auth, "Bearer phone-1.goodsignature", "the replay carries the new token");
  assert.equal(context.localStorage.getItem("gmm-sync-token"), "phone-1.goodsignature",
    "and the phone stays paired for next time");

  // A cancelled prompt must not turn into a prompt-per-queued-item.
  context.localStorage.removeItem("gmm-sync-token");
  let prompts = 0;
  context.prompt = () => { prompts += 1; return null; };
  await context.window.GMMAuth.request("/api/jobs");
  await context.window.GMMAuth.request("/api/jobs");
  await context.window.GMMAuth.request("/api/jobs");
  assert.equal(prompts, 1, "declining once must not nag on every later sync");
});

test("an unlocked Worker never asks for a PIN", {
  skip: parseHTML ? false : "linkedom is not installed"
}, async () => {
  // The other half of the deploy path: the app ships to Pages BEFORE the
  // Worker is locked. Pairing must stay quiet until the server asks for it.
  const clock = { now: Date.parse("2026-09-12T15:00:00.000Z") };
  let prompts = 0;
  const fetchImpl = async () => new Response(JSON.stringify({ jobs: [] }), { status: 200 });

  const { context } = boot({ clock, phrases: [], fetchImpl, spoken: [] });
  context.localStorage.removeItem("gmm-sync-token");
  context.prompt = () => { prompts += 1; return "406117"; };

  const response = await context.window.GMMAuth.request("/api/jobs");
  assert.equal(response.status, 200);
  assert.equal(prompts, 0, "an open Worker must not make him invent a PIN");
});
