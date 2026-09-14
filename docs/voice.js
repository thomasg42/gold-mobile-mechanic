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
  const MIN_UTTERANCE_MS = 400;
  const SPEECH_RMS = 0.012;

  /**
   * How long the app waits before deciding the mechanic is finished talking.
   *
   * `silenceHoldMs` is the whole point: a person listing the work on a truck
   * stops to think, and cutting at the first gap made the app look like it hung
   * up mid-sentence. Long patience waits out a real pause instead, and only
   * ends the turn when the silence keeps going.
   *
   *   silenceHoldMs  quiet time after speech that ends the turn
   *   leadInMs       how long to wait for the FIRST word before giving up
   *   maxMs          hard ceiling so a stuck mic cannot record forever
   *   fallbackMs     fixed window used on a phone with no audio analyser,
   *                  where there is no silence to detect
   */
  const PATIENCE = {
    normal: { silenceHoldMs: 2000, leadInMs: 8000, maxMs: 30000, fallbackMs: 8000 },
    long: { silenceHoldMs: 7000, leadInMs: 15000, maxMs: 180000, fallbackMs: 25000 }
  };

  function pacingFor(name) {
    return PATIENCE[name] || PATIENCE.normal;
  }

  let engine = "browser";
  let engineChecked = null;
  /** Shown once in the panel after a fall back, so silence is never unexplained. */
  let engineNotice = "";
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

  /** Fills {token} placeholders in the short runtime lines this file speaks. */
  function fill(template, values) {
    if (!template) return "";
    return String(template).replace(/\{(\w+)\}/g, (_, key) =>
      values[key] === null || values[key] === undefined ? "" : String(values[key]));
  }

  class VoiceCancelled extends Error {}

  /**
   * The hosted recogniser could not answer at all — dead key, expired plan, no
   * network. Emphatically NOT the same as it listening and hearing nothing,
   * and keeping the two apart is what makes the fallback below possible.
   */
  class VoiceEngineFailure extends Error {}

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

  /**
   * Stops using the hosted engine for the rest of this session.
   *
   * BOTH of these assignments are required, and the missing second one is why
   * a dead ElevenLabs key used to make the talk button do nothing at all.
   * `detectEngine()` memoises its ANSWER, not the variable, so setting
   * `engine` alone left the cached promise still resolving to "elevenlabs" —
   * every turn kept calling a service that had already failed, while the
   * fallback that checks `engine` was skipped for the same reason.
   */
  function degradeToBrowser(notice) {
    if (engine !== "elevenlabs") return;
    engine = "browser";
    engineChecked = Promise.resolve("browser");
    engineNotice = notice || "Using this phone's own voice.";
    setOverlay({ notice: engineNotice });
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
        const response = await window.GMMAuth.request("/api/voice/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: line })
        });
        if (response.ok) {
          await playBlob(await response.blob());
          return;
        }
        // ANY refusal, not just a 503. A 502 is the service itself failing —
        // an expired plan reads exactly like this — and retrying it on every
        // line only buys a round trip of silence before each sentence.
        degradeToBrowser("Using this phone's own voice.");
      } catch {
        /* A network blip: use the browser voice for this line and try again. */
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
  async function recordUtterance(pacing = PATIENCE.normal) {
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
      if (elapsed > pacing.maxMs) break;

      if (!analyser) {
        // No analyser means no silence detection; fall back to a fixed window.
        if (elapsed > pacing.fallbackMs) break;
        continue;
      }

      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (let index = 0; index < samples.length; index += 1) {
        const value = (samples[index] - 128) / 128;
        sum += value * value;
      }
      const rms = Math.sqrt(sum / samples.length);
      const waiting = heardSpeech && quietSince
        ? Math.max(0, Math.round((pacing.silenceHoldMs - (Date.now() - quietSince)) / 1000))
        : null;
      setOverlay({ level: Math.min(1, rms / 0.08), waiting });

      if (rms > SPEECH_RMS) {
        heardSpeech = true;
        quietSince = 0;
      } else if (heardSpeech) {
        if (!quietSince) quietSince = Date.now();
        else if (Date.now() - quietSince > pacing.silenceHoldMs && elapsed > MIN_UTTERANCE_MS) break;
      } else if (elapsed > pacing.leadInMs) {
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

  async function listenWithElevenLabs(pacing) {
    const { blob, heardSpeech } = await recordUtterance(pacing);
    assertLive();
    if (!heardSpeech || blob.size < 1200) return "";
    setOverlay({ state: "thinking" });
    let response;
    try {
      response = await window.GMMAuth.request("/api/voice/stt", {
        method: "POST",
        headers: { "Content-Type": blob.type || "audio/webm" },
        body: blob
      });
    } catch {
      throw new VoiceEngineFailure("Could not reach the transcriber.");
    }
    if (!response.ok) {
      degradeToBrowser("Using this phone's own dictation.");
      throw new VoiceEngineFailure("Could not hear that.");
    }
    const payload = await response.json();
    return String(payload?.text || "").trim();
  }

  /**
   * The phone's own recogniser, taught to sit through a pause.
   *
   * Left alone it ends the turn at the first gap — iOS ignores `continuous`
   * entirely and fires `onend` a beat after you stop — which is exactly the
   * "it cut me off mid-sentence" complaint. So the turn is owned here, not by
   * the recogniser: every `onend` inside the patience window simply restarts
   * it and keeps appending, and the turn ends only on real silence, on the
   * hard ceiling, or when nothing is ever said.
   */
  function listenWithBrowser(pacing = PATIENCE.normal) {
    return new Promise((resolve, reject) => {
      const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!Recognition) {
        reject(new Error("This phone has no speech recognition."));
        return;
      }

      const startedAt = Date.now();
      let finalText = "";
      let liveText = "";
      let lastVoiceAt = Date.now();
      let settled = false;
      let current = null;
      let watchdog = null;

      // Finalised text survives each restart; only the interim tail is replaced.
      const transcript = () => `${finalText}${liveText}`.replace(/\s+/g, " ").trim();

      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearInterval(watchdog);
        activeRecognition = null;
        try {
          current?.stop();
        } catch {
          /* Already stopped. */
        }
        resolve(String(value || "").trim());
      };

      const listenLonger = () => {
        const recognition = new Recognition();
        current = recognition;
        activeRecognition = recognition;
        recognition.lang = "en-US";
        recognition.interimResults = true;
        recognition.maxAlternatives = 1;
        // Honoured on desktop, ignored on iOS — the restart below covers both.
        recognition.continuous = true;

        recognition.onresult = (event) => {
          let interim = "";
          for (let index = event.resultIndex ?? 0; index < event.results.length; index += 1) {
            const result = event.results[index];
            if (result.isFinal) finalText += `${result[0].transcript} `;
            else interim += result[0].transcript;
          }
          liveText = interim;
          lastVoiceAt = Date.now();
          setOverlay({ heard: transcript() });
        };

        recognition.onerror = (event) => {
          // "no-speech" and "aborted" are what a pause looks like; only a
          // refused microphone is actually fatal.
          const code = event?.error;
          if (code === "not-allowed" || code === "service-not-allowed") finish(transcript());
        };

        recognition.onend = () => {
          if (settled || cancelled) {
            finish(transcript());
            return;
          }
          // A restart drops whatever interim tail was never finalised, so keep
          // it rather than losing the last few words of a long answer.
          if (liveText.trim()) {
            finalText += `${liveText.trim()} `;
            liveText = "";
          }
          const spoken = transcript();
          const elapsed = Date.now() - startedAt;
          const quietFor = Date.now() - lastVoiceAt;
          if (elapsed >= pacing.maxMs) return finish(spoken);
          if (spoken && quietFor >= pacing.silenceHoldMs) return finish(spoken);
          if (!spoken && elapsed >= pacing.leadInMs) return finish("");
          try {
            listenLonger();
          } catch {
            finish(spoken);
          }
        };

        try {
          recognition.start();
        } catch {
          finish(transcript());
        }
      };

      // `continuous` recognisers never fire `onend` during a pause, so the
      // silence cut is enforced here as well as in `onend`.
      watchdog = setInterval(() => {
        if (settled) return;
        if (cancelled) return finish(transcript());
        const elapsed = Date.now() - startedAt;
        const quietFor = Date.now() - lastVoiceAt;
        const spoken = transcript();
        if (spoken) {
          const remaining = Math.max(0, Math.round((pacing.silenceHoldMs - quietFor) / 1000));
          setOverlay({ waiting: quietFor > 900 ? remaining : null });
        }
        if (elapsed >= pacing.maxMs) return finish(spoken);
        if (spoken && quietFor >= pacing.silenceHoldMs) return finish(spoken);
        if (!spoken && elapsed >= pacing.leadInMs) return finish("");
      }, 250);

      listenLonger();
    });
  }

  /**
   * One turn of listening, with a fallback that is actually reachable.
   *
   * The bug this shape exists to prevent: when the hosted recogniser is the
   * engine and it FAILS, the old guard here (`engine !== "elevenlabs"`) was
   * false, so the phone's own recogniser was never tried. With a dead
   * ElevenLabs key that produced exactly one symptom — the panel records, the
   * "take your time" counter runs down, and then nothing happens, every turn,
   * with no error anywhere. Talking to Anya looked broken because listening
   * silently returned "" forever.
   *
   * So the two outcomes are kept apart. Hearing nothing is a COMPLETED listen:
   * the mechanic said nothing, and re-recording would only ask him to repeat
   * himself into a second microphone grant. A failure is not a listen at all,
   * and it hands the turn to the browser engine instead.
   */
  async function listen(patience) {
    assertLive();
    const pacing = pacingFor(patience);
    setOverlay({ state: "listening", heard: "", waiting: null, notice: engineNotice });
    let heard = "";
    let remoteFailed = false;

    if ((await detectEngine()) === "elevenlabs") {
      try {
        heard = await listenWithElevenLabs(pacing);
      } catch (error) {
        if (error instanceof VoiceCancelled) throw error;
        remoteFailed = true;
      }
    }

    if (!heard && (remoteFailed || engine !== "elevenlabs")) {
      try {
        heard = await listenWithBrowser(pacing);
      } catch (error) {
        if (error instanceof VoiceCancelled) throw error;
        // Both engines are gone — an old Android WebView with no
        // SpeechRecognition, on a phone whose hosted key has expired. Say so
        // and open the keyboard, rather than looping "I didn't catch that".
        offerTyping("Voice isn't working on this phone — type your answer.");
      }
    }

    assertLive();
    // A turn that recorded and came back with nothing is where a mechanic gets
    // stuck, so put the keyboard in front of him instead of asking again.
    if (!heard) offerTyping();
    setOverlay({ heard, waiting: null });
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
  // "not correct" is the phrase Thomas actually says, and it used to be read as
  // a YES — NEGATIVE never matched it, and AFFIRMATIVE matched the word
  // "correct" sitting inside it. Every negation that wraps an affirmative word
  // ("not right", "isn't correct", "that's not it") is spelled out here, and
  // NEGATIVE is still tested first.
  const NEGATIVE = /\b(no|nope|nah|negative|wrong|incorrect|nay|change|fix|redo|scratch that)\b|\b(?:not|isn'?t|ain'?t|aren'?t|is not|that'?s not)\s+(?:quite\s+|really\s+|totally\s+|all\s+)?(?:correct|right|it|good|true|the one)\b/i;
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

  /**
   * A bare "no" on its own is a refusal, not an answer — "Do we need any
   * materials?" / "no" must leave the list empty rather than record a part
   * called "no". Matched whole-string only, so "no issues found" is still a
   * real answer.
   */
  const BARE_NO = /^\s*(no|nope|nah|none|negative|no thanks|not really|nothing)\s*[.!]?\s*$/i;

  function isSkip(text) {
    return SKIP.test(String(text || "")) || BARE_NO.test(String(text || ""));
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
      // "yeah, spark plugs and a belt" — the lead-in is an answer to the
      // question, not the first item on the list.
      .replace(/^\s*(yes|yeah|yep|yup|sure|ok|okay)\b[\s,.-]*/i, "")
      .split(/,|\band\b|\bplus\b|\balso\b/i)
      .map((part) => part.replace(/^\s*(a|an|the|some)\s+/i, "").trim())
      .map((part) => part.replace(/[.]+$/, "").trim())
      .filter((part) => part.length > 1);
  }

  /**
   * A person's name is whatever they say it is. Only the lead-in phrase and
   * trailing punctuation come off — no title casing, no dictionary, no
   * "helpful" respelling. "DeShawn", "McCrae" and "jo-Anne" all survive
   * exactly as dictated, and the flow reads the spelling back for a yes.
   */
  function cleanSpokenName(text) {
    return String(text || "")
      .replace(/^(it'?s|this is|the customer is|customer is|his name is|her name is|their name is|name is|for)\s+/i, "")
      .replace(/[.,]+$/, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  /** "four zero six five five five..." -> "4065550147" */
  function parsePhone(text) {
    const words = {
      zero: "0", oh: "0", o: "0", one: "1", two: "2", to: "2", too: "2",
      three: "3", four: "4", for: "4", five: "5", six: "6", seven: "7",
      eight: "8", ate: "8", nine: "9"
    };
    const digits = String(text || "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .map((token) => (words[token] !== undefined ? words[token] : token))
      .join("")
      .replace(/\D/g, "");
    const local = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
    if (local.length !== 10) return "";
    return `${local.slice(0, 3)} ${local.slice(3, 6)} ${local.slice(6)}`;
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
        <p class="voice-waiting" id="voiceWaiting"></p>
        <p class="voice-notice" id="voiceNotice"></p>
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
    // A long pause is deliberate, so say so — silence with a blank panel is
    // indistinguishable from a frozen app.
    if (patch.waiting !== undefined) {
      const line = overlay.querySelector("#voiceWaiting");
      line.textContent = patch.waiting === null || patch.waiting === undefined
        ? ""
        : `Still listening — take your time (${patch.waiting}s)`;
    }
    if (patch.notice !== undefined) {
      overlay.querySelector("#voiceNotice").textContent = patch.notice || "";
    }
  }

  /**
   * Opens the typing row without waiting to be asked.
   *
   * "Type instead" was always there, behind a button, which is no help at all
   * when the failure mode is that nothing visibly happens — there is no moment
   * that tells you to go looking for it.
   */
  function offerTyping(notice) {
    if (!overlay) return;
    const row = overlay.querySelector("#voiceTypedRow");
    if (row) row.classList.remove("hidden");
    if (notice) setOverlay({ notice });
  }

  function showOverlay() {
    buildOverlay();
    if (!overlay.open) overlay.showModal();
    setOverlay({ state: "idle", question: "", heard: "", waiting: null });
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
  async function ask(step, context = {}) {
    const prompt = typeof step.prompt === "function" ? step.prompt(context) : step.prompt;
    let attempts = 0;

    while (attempts < 4) {
      attempts += 1;
      await speak(attempts === 1 ? prompt : step.retry || `Sorry — ${prompt}`);
      assertLive();

      const heard = await Promise.race([listen(step.patience), typedAnswer()]);
      assertLive();

      if (!heard) continue;
      if (step.optional && isSkip(heard)) return null;

      const value = step.parse ? step.parse(heard) : heard.trim();
      const empty =
        value === null ||
        value === undefined ||
        value === "" ||
        (Array.isArray(value) && !value.length);
      if (!empty) {
        // A step that carries its own read-back — a name, where the exact
        // spelling matters — is confirmed the moment it is captured rather
        // than waiting for the section summary at the end.
        if (step.confirmEach) {
          if (await confirm(step.confirmEach(value))) return value;
          await speak(step.retryAfterNo || "Let's try that again.");
          continue;
        }
        return value;
      }
      if (step.optional && attempts >= 2) return null;
    }

    // Four failed attempts is a bad-audio situation, not a stubborn mechanic.
    throw new Error(`Could not capture ${step.label || "that answer"}. Finish it by hand.`);
  }

  /**
   * Reads something back and returns true only on an explicit yes. A summary
   * already phrased as a question is asked verbatim, so a step can use its own
   * wording ("Is Jon, spelled J-O-N, correct?") instead of the generic tail.
   */
  async function confirmHeard(summary) {
    const question = /\?\s*$/.test(String(summary || "")) ? String(summary) : `${summary} Is that correct?`;
    let attempts = 0;
    let heard = "";
    while (attempts < 3) {
      attempts += 1;
      await speak(attempts === 1 ? question : "Is that correct? Yes or no.");
      heard = await Promise.race([listen(), typedAnswer()]);
      assertLive();
      const answer = parseYesNo(heard);
      // The rejection usually names the problem in the same breath — "no, the
      // phone number is wrong" — so the raw words go back to the caller and
      // only the named part gets re-asked.
      if (answer !== null) return { answer, heard };
    }
    return { answer: false, heard };
  }

  async function confirm(summary) {
    return (await confirmHeard(summary)).answer;
  }

  /** "the customer name" -> "customer name" */
  function stepLabel(step) {
    return String(step?.label || step?.name || "that part").replace(/^the\s+/i, "");
  }

  /** Joins labels the way a person reads a list: "a, b, or c". */
  function orList(values) {
    if (values.length <= 1) return values[0] || "";
    return `${values.slice(0, -1).join(", ")}, or ${values.at(-1)}`;
  }

  /**
   * Works out which single step a rejection is pointing at. Scored rather than
   * first-match, because "the customer's phone number" mentions both the
   * customer name and the phone number and only one of them is the answer.
   * A tie is deliberately no match — guessing the wrong field to re-ask is
   * worse than asking which one.
   */
  function matchStep(steps, heard) {
    const raw = ` ${String(heard || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ")} `;
    if (!raw.trim()) return null;
    let best = null;
    let bestScore = 0;
    let tied = false;
    for (const step of steps) {
      const terms = [
        ...stepLabel(step).toLowerCase().split(/\s+/),
        ...(step.aliases || []).map((alias) => String(alias).toLowerCase())
      ].filter((term) => term.length > 2);
      const score = new Set(terms.filter((term) => raw.includes(` ${term} `))).size;
      if (!score) continue;
      if (score > bestScore) {
        best = step;
        bestScore = score;
        tied = false;
      } else if (score === bestScore) {
        tied = true;
      }
    }
    return tied ? null : best;
  }

  const WHOLE_SECTION = /\b(all of it|all of them|everything|the whole thing|start over|over again|both)\b/i;

  /**
   * Runs one section: asks every step, writes each answer into its real form
   * field as it lands, then reads the whole section back.
   *
   * A "no" used to throw the entire section away and re-ask every question in
   * it, so correcting one digit of a phone number meant re-dictating the name
   * and the email too. Now the rejection is read for which part is wrong —
   * either from the same breath ("no, the phone number") or from one follow-up
   * question — and only that step is asked again. Everything already confirmed
   * stays exactly as captured.
   */
  async function runSection(section, context = {}) {
    const repair = section.repair || {};
    const captured = {};

    const askStep = async (step) => {
      const seen = { ...context, ...captured };
      if (step.when && !step.when(seen)) return;
      const value = await ask(step, seen);
      captured[step.name] = value;
      if (step.apply) step.apply(value, captured);
      Object.assign(context, captured);
    };

    const askAll = async () => {
      for (const step of section.steps) await askStep(step);
    };

    await askAll();
    if (!section.summary) return captured;

    for (let pass = 0; pass < 4; pass += 1) {
      const { answer, heard } = await confirmHeard(section.summary(captured));
      if (answer) {
        await speak(section.done || "Got it.");
        return captured;
      }

      // One-step sections have nothing to disambiguate.
      let target = section.steps.length === 1 ? section.steps[0] : matchStep(section.steps, heard);
      let wholeSection = WHOLE_SECTION.test(heard || "");

      if (!target && !wholeSection && pass < 3) {
        const choices = orList(section.steps.map(stepLabel));
        await speak(fill(repair.which, { choices })
          || `Which part should I fix — ${choices}? Say the one that's wrong, or say all of it.`);
        const named = await Promise.race([listen(), typedAnswer()]);
        assertLive();
        target = matchStep(section.steps, named);
        wholeSection = !target && WHOLE_SECTION.test(named || "");
      }

      if (target && !wholeSection) {
        await speak(fill(repair.fixing, { label: target.label || stepLabel(target) })
          || `Okay, let's fix ${stepLabel(target)}.`);
        await askStep(target);
        continue;
      }

      await speak((wholeSection ? repair.whole : repair.unclear)
        || repair.whole
        || "No problem, let's go through that part again.");
      await askAll();
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
      const result = await flow({
        speak, ask, confirm, runSection, listen, capturePhoto,
        // The shop agent drives its own turn order, so it needs the same typed
        // fallback and status label `ask` uses rather than re-implementing them.
        typedAnswer,
        setState: (state, question) => setOverlay({ state, question }),
      });
      if (flow.farewell !== null) await speak(flow.farewell || "All set.");
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
      phone: parsePhone,
      list: parseList,
      name: cleanSpokenName,
      sentence: cleanSentence,
      isSkip,
      escapeHtml
    }
  };
})();
