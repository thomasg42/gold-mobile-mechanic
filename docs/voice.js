/**
 * Hands-free voice interviews for Gold Mobile Mechanic.
 *
 * The app owns the question order and the read-back; ElevenLabs only supplies
 * the ears and the mouth. That split is deliberate — a model left to drive the
 * flow will skip fields and then cheerfully confirm values it never captured,
 * which is exactly the failure a mechanic under a truck cannot catch.
 *
 * Every answer lands in the real form input, so a half-finished interview
 * leaves behind a normal form that can be finished by thumb.
 */
(() => {
  "use strict";

  const SYNC_API = "https://gold-mobile-mechanic-sync.forevergoldai.workers.dev";
  const SILENCE_HOLD_MS = 1200;
  const MAX_UTTERANCE_MS = 15000;
  const MIN_UTTERANCE_MS = 400;
  const SPEECH_RMS = 0.012;

  let engine = "browser";
  let engineChecked = null;
  let sharedAudio = null;
  let audioContext = null;
  let activeStream = null;
  let activeRecorder = null;
  let activeRecognition = null;
  let cancelled = false;
  let running = false;

  // ---------------------------------------------------------------- utilities

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[character]);
  }

  class VoiceCancelled extends Error {}

  function assertLive() {
    if (cancelled) throw new VoiceCancelled("Voice stopped.");
  }

  // ------------------------------------------------------------- audio output

  /**
   * iOS refuses to play any audio element that was not first started inside a
   * user gesture, so one element is unlocked on the opening tap and reused for
   * every line afterwards rather than building a fresh element per chunk.
   */
  function unlockAudio() {
    if (!sharedAudio) {
      sharedAudio = new Audio();
      sharedAudio.setAttribute("playsinline", "");
      sharedAudio.preload = "auto";
    }
    try {
      sharedAudio.src =
        "data:audio/mpeg;base64,//uQxAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAACcQCA";
      const played = sharedAudio.play();
      if (played?.catch) played.catch(() => {});
    } catch {
      /* A blocked unlock only costs us the ElevenLabs voice, not the flow. */
    }
    try {
      const Context = window.AudioContext || window.webkitAudioContext;
      if (Context) {
        if (!audioContext) audioContext = new Context();
        if (audioContext.state === "suspended") void audioContext.resume();
      }
    } catch {
      /* Same. */
    }
  }

  async function detectEngine() {
    if (engineChecked !== null) return engineChecked;
    engineChecked = (async () => {
      try {
        const response = await fetch(`${SYNC_API}/api/health`, { cache: "no-store" });
        const payload = await response.json();
        engine = payload?.voice ? "elevenlabs" : "browser";
      } catch {
        engine = "browser";
      }
      return engine;
    })();
    return engineChecked;
  }

  function speakWithBrowser(text) {
    return new Promise((resolve) => {
      if (!("speechSynthesis" in window)) {
        resolve();
        return;
      }
      try {
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = 1.02;
        utterance.onend = () => resolve();
        utterance.onerror = () => resolve();
        window.speechSynthesis.speak(utterance);
        // Safari drops the end event often enough that a ceiling is required
        // or the interview stalls forever on a line it already finished.
        setTimeout(resolve, Math.min(20000, 900 + text.length * 90));
      } catch {
        resolve();
      }
    });
  }

  function playBlob(blob) {
    return new Promise((resolve) => {
      if (!sharedAudio) {
        resolve();
        return;
      }
      const url = URL.createObjectURL(blob);
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        sharedAudio.onended = null;
        sharedAudio.onerror = null;
        URL.revokeObjectURL(url);
        resolve();
      };
      sharedAudio.onended = done;
      sharedAudio.onerror = done;
      sharedAudio.src = url;
      const played = sharedAudio.play();
      if (played?.catch) played.catch(done);
    });
  }

  async function speak(text) {
    assertLive();
    const line = String(text || "").trim();
    if (!line) return;
    setOverlay({ state: "speaking", question: line });
    if ((await detectEngine()) === "elevenlabs") {
      try {
        const response = await fetch(`${SYNC_API}/api/voice/tts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: line })
        });
        if (response.ok) {
          await playBlob(await response.blob());
          return;
        }
        // A 503 means the key was never set; stop paying the round trip.
        if (response.status === 503) engine = "browser";
      } catch {
        /* Fall through to the browser voice. */
      }
    }
    await speakWithBrowser(line);
  }

  // -------------------------------------------------------------- audio input

  function stopStream() {
    if (activeStream) {
      activeStream.getTracks().forEach((track) => track.stop());
      activeStream = null;
    }
  }

  function pickMimeType() {
    const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/aac"];
    for (const type of candidates) {
      if (window.MediaRecorder?.isTypeSupported?.(type)) return type;
    }
    return "";
  }

  /**
   * Records one utterance and cuts it at a real silence boundary. Returning the
   * clip rather than a live stream keeps the whole thing inside a single
   * getUserMedia grant per interview.
   */
  async function recordUtterance() {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    activeStream = stream;

    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    activeRecorder = recorder;
    const chunks = [];
    recorder.ondataavailable = (event) => {
      if (event.data?.size) chunks.push(event.data);
    };

    const Context = window.AudioContext || window.webkitAudioContext;
    if (!audioContext && Context) audioContext = new Context();
    if (audioContext?.state === "suspended") await audioContext.resume();
    const analyser = audioContext ? audioContext.createAnalyser() : null;
    let source = null;
    if (analyser) {
      analyser.fftSize = 1024;
      source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);
    }

    const finished = new Promise((resolve) => {
      recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType || "audio/webm" }));
    });

    recorder.start();
    const startedAt = Date.now();
    const samples = analyser ? new Uint8Array(analyser.fftSize) : null;
    let heardSpeech = false;
    let quietSince = 0;

    while (recorder.state === "recording") {
      await sleep(90);
      if (cancelled) break;
      const elapsed = Date.now() - startedAt;
      if (elapsed > MAX_UTTERANCE_MS) break;

      if (!analyser) {
        // No analyser means no silence detection; fall back to a fixed window.
        if (elapsed > 6000) break;
        continue;
      }

      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (let index = 0; index < samples.length; index += 1) {
        const value = (samples[index] - 128) / 128;
        sum += value * value;
      }
      const rms = Math.sqrt(sum / samples.length);
      setOverlay({ level: Math.min(1, rms / 0.08) });

      if (rms > SPEECH_RMS) {
        heardSpeech = true;
        quietSince = 0;
      } else if (heardSpeech) {
        if (!quietSince) quietSince = Date.now();
        else if (Date.now() - quietSince > SILENCE_HOLD_MS && elapsed > MIN_UTTERANCE_MS) break;
      } else if (elapsed > 7000) {
        // Nothing was ever said — stop rather than record the driveway.
        break;
      }
    }

    if (recorder.state !== "inactive") recorder.stop();
    const blob = await finished;
    try {
      source?.disconnect();
      analyser?.disconnect();
    } catch {
      /* Disconnect failures are harmless here. */
    }
    stopStream();
    activeRecorder = null;
    return { blob, heardSpeech };
  }

  async function listenWithElevenLabs() {
    const { blob, heardSpeech } = await recordUtterance();
    assertLive();
    if (!heardSpeech || blob.size < 1200) return "";
    setOverlay({ state: "thinking" });
    const response = await fetch(`${SYNC_API}/api/voice/stt`, {
      method: "POST",
      headers: { "Content-Type": blob.type || "audio/webm" },
      body: blob
    });
    if (!response.ok) {
      if (response.status === 503) engine = "browser";
      throw new Error("Could not hear that.");
    }
    const payload = await response.json();
    return String(payload?.text || "").trim();
  }

  function listenWithBrowser() {
    return new Promise((resolve, reject) => {
      const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!Recognition) {
        reject(new Error("This phone has no speech recognition."));
        return;
      }
      const recognition = new Recognition();
      activeRecognition = recognition;
      recognition.lang = "en-US";
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;
      let best = "";
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        activeRecognition = null;
        try {
          recognition.stop();
        } catch {
          /* Already stopped. */
        }
        resolve(value.trim());
      };
      recognition.onresult = (event) => {
        let text = "";
        for (let index = 0; index < event.results.length; index += 1) {
          text += event.results[index][0].transcript;
        }
        best = text;
        setOverlay({ heard: text });
      };
      recognition.onerror = () => finish(best);
      recognition.onend = () => finish(best);
      try {
        recognition.start();
      } catch {
        finish("");
      }
      setTimeout(() => finish(best), MAX_UTTERANCE_MS);
    });
  }

  async function listen() {
    assertLive();
    setOverlay({ state: "listening", heard: "" });
    let heard = "";
    if ((await detectEngine()) === "elevenlabs") {
      try {
        heard = await listenWithElevenLabs();
      } catch (error) {
        if (error instanceof VoiceCancelled) throw error;
        heard = "";
      }
    }
    if (!heard && engine !== "elevenlabs") heard = await listenWithBrowser();
    assertLive();
    setOverlay({ heard });
    return heard;
  }

  // ----------------------------------------------------------------- language

  const SMALL_NUMBERS = {
    zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
    eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
    fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19
  };
  const TENS = {
    twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50,
    sixty: 60, seventy: 70, eighty: 80, ninety: 90
  };

  function wordsToNumberGroups(text) {
    const tokens = String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9.\s-]/g, " ")
      .split(/[\s-]+/)
      .filter(Boolean);
    const groups = [];
    let current = null;
    let pending = 0;
    // Tracks the last magnitude added so a spoken run can be split into
    // separate numbers: "forty two fifty" is 42 then 50, not 92.
    let lastAdded = Infinity;

    const flush = () => {
      if (current !== null || pending) groups.push((current || 0) + pending);
      current = null;
      pending = 0;
      lastAdded = Infinity;
    };

    const addPart = (value) => {
      // A part that is not smaller than the previous one cannot be continuing
      // the same number, so it starts the next one.
      if (pending > 0 && value >= lastAdded) flush();
      pending += value;
      current = current ?? 0;
      lastAdded = value;
    };

    for (const token of tokens) {
      if (/^\d+(\.\d+)?$/.test(token)) {
        flush();
        groups.push(Number.parseFloat(token));
        continue;
      }
      if (token in SMALL_NUMBERS) {
        addPart(SMALL_NUMBERS[token]);
      } else if (token in TENS) {
        addPart(TENS[token]);
      } else if (token === "hundred") {
        current = ((current || 0) + (pending || 1)) * 100;
        pending = 0;
        lastAdded = Infinity;
      } else if (token === "thousand") {
        current = ((current || 0) + (pending || 1)) * 1000;
        pending = 0;
        lastAdded = Infinity;
      } else if (token === "and") {
        // "a hundred and twenty five" keeps accumulating.
      } else {
        flush();
      }
    }
    flush();
    return groups;
  }

  /**
   * Turns spoken money into cents. `style` disambiguates the one genuinely
   * ambiguous pattern: "one twenty five" is $125 an hour as a rate but $1.25
   * as a receipt total. The read-back is what actually catches a bad guess.
   */
  function parseSpokenMoney(text, style = "amount") {
    const raw = String(text || "").toLowerCase();
    if (!raw.trim()) return null;

    const explicit = raw.match(/\$?\s*(\d{1,6})(?:[.,](\d{1,2}))?\s*(?:dollars?|bucks?)?/);
    const hasDigits = /\d/.test(raw);
    if (hasDigits && explicit) {
      const dollars = Number.parseInt(explicit[1], 10);
      const centsPart = explicit[2] ? Number.parseInt(explicit[2].padEnd(2, "0"), 10) : 0;
      const trailing = raw.slice(explicit.index + explicit[0].length);
      const spokenCents = trailing.match(/(\d{1,2})\s*cents?/);
      if (!explicit[2] && spokenCents) {
        return dollars * 100 + Number.parseInt(spokenCents[1], 10);
      }
      return dollars * 100 + centsPart;
    }

    const dollarSplit = raw.split(/\bdollars?\b/);
    if (dollarSplit.length > 1) {
      const dollars = wordsToNumberGroups(dollarSplit[0]).pop() || 0;
      const centsGroups = wordsToNumberGroups(dollarSplit.slice(1).join(" "));
      const cents = centsGroups.length ? centsGroups[0] : 0;
      return Math.round(dollars) * 100 + Math.min(99, Math.round(cents));
    }

    const groups = wordsToNumberGroups(raw);
    if (!groups.length) return null;
    if (groups.length === 1) return Math.round(groups[0] * 100);

    const [first, second] = groups;
    if (style === "rate") {
      // "one twenty five" an hour means 125, not 1.25.
      if (first < 10 && second >= 10 && second <= 99) return (first * 100 + second) * 100;
      return Math.round(first * 100);
    }
    if (second >= 0 && second <= 99) return Math.round(first) * 100 + Math.round(second);
    return Math.round(first * 100);
  }

  const AFFIRMATIVE = /\b(yes|yeah|yep|yup|correct|right|affirmative|sure|good|perfect|that's it|thats it|looks good|sounds good|ok|okay)\b/i;
  const NEGATIVE = /\b(no|nope|nah|negative|wrong|incorrect|not right|change|fix|redo)\b/i;
  const SKIP = /\b(skip|none|nothing|no thanks|don't have|dont have|not sure|pass|leave it|blank)\b/i;

  function parseYesNo(text) {
    const raw = String(text || "");
    if (!raw.trim()) return null;
    // "no" inside "no thanks" is still a no, but check negatives first so
    // "no, that's wrong" is not read as a yes on the word "that's".
    if (NEGATIVE.test(raw)) return false;
    if (AFFIRMATIVE.test(raw)) return true;
    return null;
  }

  function isSkip(text) {
    return SKIP.test(String(text || ""));
  }

  const VEHICLE_MAKES = [
    "acura", "alfa romeo", "aston martin", "audi", "bentley", "bmw", "buick",
    "cadillac", "chevrolet", "chevy", "chrysler", "dodge", "ferrari", "fiat",
    "ford", "genesis", "gmc", "honda", "hummer", "hyundai", "infiniti", "isuzu",
    "jaguar", "jeep", "kia", "lamborghini", "land rover", "lexus", "lincoln",
    "maserati", "mazda", "mclaren", "mercedes", "mercedes-benz", "mercury",
    "mini", "mitsubishi", "nissan", "oldsmobile", "peugeot", "plymouth",
    "polestar", "pontiac", "porsche", "ram", "renault", "rivian", "rolls royce",
    "saab", "saturn", "scion", "smart", "subaru", "suzuki", "tesla", "toyota",
    "volkswagen", "vw", "volvo"
  ];
  const MAKE_SPELLING = {
    chevy: "Chevrolet",
    vw: "Volkswagen",
    "mercedes": "Mercedes-Benz"
  };

  function titleCase(value) {
    return String(value || "")
      .split(/\s+/)
      .filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  }

  /** "a 2018 Ford F-150" -> { year: "2018", make: "Ford", model: "F-150" } */
  function parseVehicle(text) {
    const raw = String(text || "").trim();
    if (!raw) return null;
    const cleaned = raw.replace(/^(it'?s\s+|a\s+|an\s+|the\s+)+/i, "").replace(/[.,]+$/, "");
    const lower = cleaned.toLowerCase();

    let year = "";
    const yearMatch = lower.match(/\b((?:19|20)\d{2})\b/);
    if (yearMatch) year = yearMatch[1];

    let make = "";
    let makeIndex = -1;
    let makeLength = 0;
    // Longest match first so "land rover" beats a bare "rover" style partial.
    for (const candidate of [...VEHICLE_MAKES].sort((a, b) => b.length - a.length)) {
      const index = lower.indexOf(candidate);
      if (index === -1) continue;
      const before = index === 0 || /\W/.test(lower[index - 1]);
      const after =
        index + candidate.length >= lower.length || /\W/.test(lower[index + candidate.length]);
      if (before && after) {
        make = MAKE_SPELLING[candidate] || titleCase(candidate);
        makeIndex = index;
        makeLength = candidate.length;
        break;
      }
    }

    let model = "";
    if (makeIndex >= 0) {
      model = cleaned.slice(makeIndex + makeLength);
    } else {
      model = year ? cleaned.replace(year, "") : cleaned;
    }
    model = model
      .replace(new RegExp(`\\b${year}\\b`), "")
      .replace(/[.,]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    // "F 150" and "f150" both really mean F-150.
    model = model.replace(/\b([a-zA-Z])\s?-?\s?(\d{2,4})\b/g, (_, letter, digits) =>
      `${letter.toUpperCase()}-${digits}`);
    model = titleCase(model);

    if (!year && !make && !model) return null;
    return { year, make, model };
  }

  function parseEmail(text) {
    const raw = String(text || "")
      .toLowerCase()
      .replace(/\s+at\s+/g, "@")
      .replace(/\s+dot\s+/g, ".")
      .replace(/\s+underscore\s+/g, "_")
      .replace(/\s+dash\s+|\s+hyphen\s+/g, "-")
      .replace(/\s+/g, "");
    const match = raw.match(/[^@\s]+@[^@\s]+\.[a-z]{2,}/);
    return match ? match[0] : "";
  }

  function parsePlate(text) {
    const raw = String(text || "").toUpperCase().replace(/[^A-Z0-9\s]/g, " ");
    return raw.replace(/\s+/g, "").slice(0, 10);
  }

  /** Splits "spark plugs, oil filter and a serpentine belt" into three items. */
  function parseList(text) {
    return String(text || "")
      .split(/,|\band\b|\bplus\b|\balso\b/i)
      .map((part) => part.replace(/^\s*(a|an|the|some)\s+/i, "").trim())
      .map((part) => part.replace(/[.]+$/, "").trim())
      .filter((part) => part.length > 1);
  }

  function cleanSpokenName(text) {
    const raw = String(text || "")
      .replace(/^(it'?s|this is|the customer is|customer is|his name is|her name is|their name is|name is|for)\s+/i, "")
      .replace(/[.,]+$/, "")
      .trim();
    return titleCase(raw);
  }

  function cleanSentence(text) {
    const raw = String(text || "").trim().replace(/^(we'?re|we are|i'?m|im)\s+/i, "");
    if (!raw) return "";
    return raw.charAt(0).toUpperCase() + raw.slice(1);
  }

  // ------------------------------------------------------------------ overlay

  let overlay = null;
  let overlayState = {};

  function buildOverlay() {
    if (overlay) return overlay;
    // A <dialog> rather than a plain div: the job and receipt sheets are opened
    // with showModal(), which puts them in the browser's top layer where no
    // z-index can reach them. An overlay that is not itself a modal ends up
    // underneath, and every button on it — Stop, Type instead, Take receipt
    // photo — becomes unclickable.
    overlay = document.createElement("dialog");
    overlay.className = "voice-overlay";
    overlay.innerHTML = `
      <div class="voice-panel" aria-label="Voice assistant">
        <div class="voice-status">
          <span class="voice-orb" id="voiceOrb" aria-hidden="true"></span>
          <span class="voice-state" id="voiceStateLabel">Starting</span>
        </div>
        <p class="voice-question" id="voiceQuestion"></p>
        <p class="voice-heard" id="voiceHeard"></p>
        <div class="voice-typed hidden" id="voiceTypedRow">
          <input id="voiceTypedInput" placeholder="Type the answer" autocomplete="off">
          <button class="button button-gold" id="voiceTypedSubmit" type="button">Use this</button>
        </div>
        <div class="voice-tap-holder hidden" id="voiceTapHolder"></div>
        <div class="voice-actions">
          <button class="text-button" id="voiceTypeButton" type="button">Type instead</button>
          <button class="button button-red" id="voiceStopButton" type="button">Stop voice</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    // Esc must end the interview rather than just hide the panel, or the flow
    // would keep asking questions with nothing on screen.
    overlay.addEventListener("cancel", (event) => {
      event.preventDefault();
      stopVoice();
    });
    overlay.querySelector("#voiceStopButton").addEventListener("click", () => stopVoice());
    overlay.querySelector("#voiceTypeButton").addEventListener("click", () => {
      const row = overlay.querySelector("#voiceTypedRow");
      row.classList.toggle("hidden");
      if (!row.classList.contains("hidden")) overlay.querySelector("#voiceTypedInput").focus();
    });
    overlay.querySelector("#voiceTypedSubmit").addEventListener("click", submitTypedAnswer);
    overlay.querySelector("#voiceTypedInput").addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      submitTypedAnswer();
    });
    return overlay;
  }

  function setOverlay(patch) {
    if (!overlay) return;
    overlayState = { ...overlayState, ...patch };
    if (patch.state) {
      const labels = {
        speaking: "Speaking",
        listening: "Listening",
        thinking: "Writing it down",
        idle: "Ready"
      };
      overlay.querySelector("#voiceStateLabel").textContent = labels[patch.state] || patch.state;
      overlay.querySelector("#voiceOrb").dataset.state = patch.state;
    }
    if (patch.question !== undefined) {
      overlay.querySelector("#voiceQuestion").textContent = patch.question;
    }
    if (patch.heard !== undefined) {
      overlay.querySelector("#voiceHeard").textContent = patch.heard ? `“${patch.heard}”` : "";
    }
    if (patch.level !== undefined) {
      overlay.querySelector("#voiceOrb").style.setProperty("--voice-level", String(patch.level));
    }
  }

  function showOverlay() {
    buildOverlay();
    if (!overlay.open) overlay.showModal();
    setOverlay({ state: "idle", question: "", heard: "" });
  }

  /**
   * Re-asserts the overlay as the topmost modal. The top layer is ordered by
   * when each dialog was shown, so any sheet opened mid-interview (the receipt
   * sheet) would otherwise cover the panel and swallow its taps.
   */
  function raiseOverlay() {
    if (!overlay?.open) return;
    overlay.close();
    overlay.showModal();
  }

  function hideOverlay() {
    if (!overlay) return;
    pendingTypedResolver = null;
    if (overlay.open) overlay.close();
    overlay.querySelector("#voiceTypedRow").classList.add("hidden");
    overlay.querySelector("#voiceTypedInput").value = "";
  }

  /**
   * Lets a typed answer satisfy the same await that voice would have.
   *
   * Only ever one resolver is live. Binding a fresh pair of listeners per
   * question instead would leave the losers of each `Promise.race` attached,
   * and the first stale handler to fire would clear the input before the real
   * one read it — which silently broke typing after the first question.
   */
  let pendingTypedResolver = null;

  function typedAnswer() {
    return new Promise((resolve) => {
      pendingTypedResolver = resolve;
    });
  }

  function submitTypedAnswer() {
    const input = overlay?.querySelector("#voiceTypedInput");
    const value = input?.value.trim();
    if (!value || !pendingTypedResolver) return;
    input.value = "";
    const resolve = pendingTypedResolver;
    pendingTypedResolver = null;
    resolve(value);
  }

  /**
   * Shows a camera button inside the panel and resolves once `onFiles` has
   * accepted a photo.
   *
   * The picker is a label-wrapped file input rather than a button that calls
   * .click() on an input elsewhere in the page: the sheet holding that other
   * input is inert while this panel is the topmost modal, and a camera needs
   * genuine user activation. Here the mechanic's tap *is* the activation.
   */
  function capturePhoto(labelText, onFiles) {
    buildOverlay();
    const holder = overlay.querySelector("#voiceTapHolder");
    holder.innerHTML = `
      <label class="button button-gold voice-tap">
        <span>${escapeHtml(labelText)}</span>
        <input type="file" accept="image/*" capture="environment">
      </label>`;
    holder.classList.remove("hidden");
    setOverlay({ state: "idle" });

    return new Promise((resolve, reject) => {
      const input = holder.querySelector("input");
      const cleanup = () => {
        clearInterval(poll);
        holder.classList.add("hidden");
        holder.innerHTML = "";
      };
      const poll = setInterval(() => {
        if (!cancelled) return;
        cleanup();
        reject(new VoiceCancelled("Voice stopped."));
      }, 200);
      input.addEventListener("change", async () => {
        if (!input.files?.length) return;
        try {
          await onFiles(input.files);
          cleanup();
          resolve(true);
        } catch (error) {
          // Leave the button up so another photo can be taken.
          input.value = "";
          setOverlay({ heard: error instanceof Error ? error.message : "That photo did not save." });
        }
      });
    });
  }

  // ------------------------------------------------------------------- engine

  /**
   * Asks one question until it produces a usable answer. Returns null only when
   * the step is optional and the mechanic skipped it.
   */
  async function ask(step) {
    const prompt = typeof step.prompt === "function" ? step.prompt() : step.prompt;
    let attempts = 0;

    while (attempts < 4) {
      attempts += 1;
      await speak(attempts === 1 ? prompt : step.retry || `Sorry — ${prompt}`);
      assertLive();

      const heard = await Promise.race([listen(), typedAnswer()]);
      assertLive();

      if (!heard) continue;
      if (step.optional && isSkip(heard)) return null;

      const value = step.parse ? step.parse(heard) : heard.trim();
      const empty =
        value === null ||
        value === undefined ||
        value === "" ||
        (Array.isArray(value) && !value.length);
      if (!empty) return value;
      if (step.optional && attempts >= 2) return null;
    }

    // Four failed attempts is a bad-audio situation, not a stubborn mechanic.
    throw new Error(`Could not capture ${step.label || "that answer"}. Finish it by hand.`);
  }

  /** Reads a section back and returns true only on an explicit yes. */
  async function confirm(summary) {
    let attempts = 0;
    while (attempts < 3) {
      attempts += 1;
      await speak(attempts === 1 ? `${summary} Is that correct?` : "Is that correct? Yes or no.");
      const heard = await Promise.race([listen(), typedAnswer()]);
      assertLive();
      const answer = parseYesNo(heard);
      if (answer !== null) return answer;
    }
    return false;
  }

  /**
   * Runs one section: asks every step, writes each answer into its real form
   * field as it lands, then reads the whole section back. A "no" re-asks the
   * section rather than guessing which field was wrong.
   */
  async function runSection(section) {
    for (let pass = 0; pass < 3; pass += 1) {
      const captured = {};
      for (const step of section.steps) {
        if (step.when && !step.when(captured)) continue;
        const value = await ask(step);
        captured[step.name] = value;
        if (step.apply) step.apply(value, captured);
      }
      if (!section.summary) return captured;
      if (await confirm(section.summary(captured))) {
        await speak(section.done || "Got it.");
        return captured;
      }
      await speak(pass < 2 ? "No problem, let's go through that again." : "Let's try once more.");
    }
    await speak("Let's finish this part by hand.");
    throw new Error("Section was not confirmed.");
  }

  function stopVoice() {
    cancelled = true;
    try {
      window.speechSynthesis?.cancel();
    } catch {
      /* Nothing to cancel. */
    }
    if (sharedAudio) {
      try {
        sharedAudio.pause();
      } catch {
        /* Already paused. */
      }
    }
    if (activeRecorder?.state === "recording") {
      try {
        activeRecorder.stop();
      } catch {
        /* Already stopped. */
      }
    }
    if (activeRecognition) {
      try {
        activeRecognition.stop();
      } catch {
        /* Already stopped. */
      }
    }
    stopStream();
    hideOverlay();
  }

  /**
   * Entry point for every interview. Must be called from a real tap so the
   * audio unlock and the microphone grant both land inside the gesture.
   */
  async function run(flow) {
    if (running) return { ok: false, reason: "busy" };
    running = true;
    cancelled = false;
    unlockAudio();
    showOverlay();
    try {
      const result = await flow({ speak, ask, confirm, runSection, listen, capturePhoto });
      await speak(flow.farewell || "All set.");
      return { ok: true, result };
    } catch (error) {
      if (error instanceof VoiceCancelled) return { ok: false, reason: "cancelled" };
      const message = error instanceof Error ? error.message : "Voice stopped.";
      try {
        await speak(message);
      } catch {
        /* The overlay message below is enough. */
      }
      return { ok: false, reason: "error", message };
    } finally {
      running = false;
      cancelled = true;
      stopStream();
      hideOverlay();
    }
  }

  window.GMMVoice = {
    run,
    /** Call synchronously inside the opening tap; `run` may be several awaits later. */
    prime: unlockAudio,
    /** Call after opening any modal sheet mid-interview so the panel stays tappable. */
    raise: raiseOverlay,
    stop: stopVoice,
    speak,
    isRunning: () => running,
    supported: () =>
      Boolean(navigator.mediaDevices?.getUserMedia) ||
      Boolean(window.SpeechRecognition || window.webkitSpeechRecognition),
    parse: {
      money: parseSpokenMoney,
      yesNo: parseYesNo,
      vehicle: parseVehicle,
      email: parseEmail,
      plate: parsePlate,
      list: parseList,
      name: cleanSpokenName,
      sentence: cleanSentence,
      isSkip,
      escapeHtml
    }
  };
})();
