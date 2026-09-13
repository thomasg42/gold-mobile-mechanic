/**
 * Anya on the phone — the conversational half of the invoice app.
 *
 * Two surfaces, one agent:
 *
 *   Talk to Anya   The button at the top of the invoice sheet. The mechanic
 *                  talks, she asks one thing at a time and writes the answers
 *                  straight into the real form inputs. It replaces the old
 *                  scripted interview, which could only ask the questions it
 *                  had been given, in the order it had been given them.
 *
 *   Ask Anya       A real chat, the way ChatGPT is a chat. Repair help with the
 *                  video first, and — the part that makes her worth talking to
 *                  rather than reading — she can act on the open job. "Clock me
 *                  in." "Put on there the rear brakes are getting close." The
 *                  ledger changes while his hands stay on the truck.
 *
 * Nothing here holds an API key. Every turn goes to the Worker, which owns the
 * credential and the model choice.
 *
 * HER TOOLS RUN HERE, NOT ON THE WORKER. A job-changing call comes back
 * unexecuted and is applied through `GMMAgentBridge` — the same functions the
 * buttons call — then answered with a tool result. The Worker never touches a
 * job, because this phone is what holds the offline queue, the sync state and
 * the timer, and a change made around it is a change the app does not know it
 * made.
 *
 * The voice half is deliberately NOT reimplemented. `GMMVoice.run()` already
 * owns the parts that took real work to get right on a phone — the iOS audio
 * unlock, silence detection patient enough for a mechanic who pauses to think,
 * the type-instead fallback, and a panel that survives being opened on top of a
 * `showModal()` sheet. Anya supplies a different conversation to run inside it,
 * not a second audio stack.
 */
(() => {
  "use strict";

  const SYNC_API = "https://gold-mobile-mechanic-sync.forevergoldai.workers.dev";

  /** Her name, in one place on this side too. Mirrors AGENT_NAME in assistant.ts. */
  const AGENT_NAME = "Anya";

  /** A runaway loop costs real money, so both conversations are capped. */
  const MAX_INVOICE_TURNS = 30;
  /** How many times one question may come back asking to do something. */
  const MAX_ACTION_ROUNDS = 4;

  const bridge = () => window.GMMAgentBridge || {};

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[character]);
  }

  async function post(path, payload) {
    const response = await fetch(`${SYNC_API}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    let body = null;
    try {
      body = await response.json();
    } catch {
      /* Handled as a missing body below. */
    }
    if (!response.ok) {
      const error = new Error(body?.error || `${AGENT_NAME} could not answer.`);
      error.status = response.status;
      throw error;
    }
    if (!body) throw new Error(`${AGENT_NAME} sent nothing back.`);
    return body;
  }

  /** Is she configured at all? Cached, because it gates button visibility. */
  let availability = null;
  async function available() {
    if (availability !== null) return availability;
    try {
      const response = await fetch(`${SYNC_API}/api/health`);
      const body = await response.json();
      availability = body?.assistant === true;
    } catch {
      // Offline is not "not configured" — don't cache a network blip as a no.
      return false;
    }
    return availability;
  }

  // ------------------------------------------------------------ invoice agent

  /**
   * Runs the fill-in conversation against the open job sheet.
   *
   * Every value she returns is written into the same input a thumb would type
   * into, so stopping halfway leaves a normal half-filled form rather than a
   * dead end — the one property of the old scripted interview worth keeping.
   */
  async function talkItIn() {
    if (!window.GMMVoice?.supported()) {
      bridge().notify?.("This browser can't do voice. Fill the sheet in by hand, or type into the panel.", true);
    }

    const messages = [{ role: "user", content: "Let's open a new job." }];
    let turns = 0;

    return window.GMMVoice.run(Object.assign(
      async ({ speak, listen, typedAnswer, setState }) => {
        while (turns < MAX_INVOICE_TURNS) {
          turns += 1;
          setState("thinking", "");

          let reply;
          try {
            reply = await post("/api/assistant/invoice", {
              messages,
              vehicles: bridge().knownVehicles?.() || [],
              filled: bridge().filledFields?.() || {}
            });
          } catch (error) {
            // 503 means the key was never set. Saying "try again" would be a lie.
            if (error.status === 503) {
              await speak(`${AGENT_NAME} isn't switched on yet. Fill the sheet in by hand.`);
              return { reason: "unconfigured" };
            }
            await speak(error.message || "That didn't go through. Fill it in by hand.");
            return { reason: "error" };
          }

          // Write what she heard BEFORE she speaks, so the mechanic can watch
          // the sheet fill in while the sentence is still being read out.
          applyReply(reply);
          // Handed straight to the sheet's draft rather than held here, so a
          // conversation he stops halfway does not take the aside with it.
          if (reply.notes) bridge().stashNote?.(reply.notes);

          const say = String(reply.say || "").trim();
          if (say) await speak(say);

          if (reply.ready) {
            const answer = await Promise.race([listen("normal"), typedAnswer()]);
            if (window.GMMVoice.parse.yesNo(answer) === true) {
              // Through the real form so every existing validation and every
              // existing sync rule still runs.
              const created = bridge().submitJob?.({ clockIn: reply.clockIn === true });
              if (created === false) {
                await speak("Something on the sheet still isn't right. Take a look.");
                return { reason: "invalid" };
              }
              await speak(reply.clockIn
                ? "Saved, and you're on the clock."
                : "Saved. The job's open.");
              return { reason: "created" };
            }
            messages.push({ role: "assistant", content: say || "Is that right?" });
            messages.push({ role: "user", content: answer || "no" });
            continue;
          }

          const heard = await Promise.race([listen("long"), typedAnswer()]);
          if (!heard) {
            await speak("I didn't catch that.");
            messages.push({ role: "assistant", content: say });
            messages.push({ role: "user", content: "(nothing heard)" });
            continue;
          }
          messages.push({ role: "assistant", content: say });
          messages.push({ role: "user", content: heard });
        }

        await speak("That's gone on a while. Finish the rest on the sheet.");
        return { reason: "max_turns" };
      },
      // The harness's own "All set." would talk over the read-back this flow
      // already gave, and would speak after a failure too.
      { farewell: null }
    ));
  }

  /** Writes one reply into the open sheet. */
  function applyReply(reply) {
    const fields = reply?.fields && typeof reply.fields === "object" ? reply.fields : {};
    for (const [name, value] of Object.entries(fields)) {
      const text = String(value ?? "").trim();
      // An empty string means "no change" — it must never wipe a field the
      // mechanic typed himself before starting the conversation.
      if (text) bridge().setField?.(name, text);
    }
    if (Array.isArray(reply?.materials) && reply.materials.length) {
      bridge().setMaterials?.(reply.materials);
    }
  }

  // --------------------------------------------------------------- chat agent

  let panel = null;
  let chatMessages = [];
  let chatBusy = false;
  let speakReplies = false;
  let chatVehicle = null;

  function buildPanel() {
    if (panel) return panel;
    // A <dialog> for the same reason the voice overlay is one: the job sheet is
    // opened with showModal(), and anything that is not itself modal lands
    // under it in the top layer and stops taking taps.
    panel = document.createElement("dialog");
    panel.className = "agent-panel";
    panel.innerHTML = `
      <div class="agent-shell">
        <div class="agent-head">
          <div>
            <p class="eyebrow">${AGENT_NAME}</p>
            <h2 id="agentVehicle">Ask anything</h2>
          </div>
          <div class="agent-head-actions">
            <button class="text-button" id="agentSpeakToggle" type="button" aria-pressed="false">Read aloud: off</button>
            <button class="icon-button" id="agentClose" type="button" aria-label="Close">&times;</button>
          </div>
        </div>
        <div class="agent-thread" id="agentThread" aria-live="polite"></div>
        <form class="agent-composer" id="agentComposer">
          <button class="agent-mic" id="agentMic" type="button" aria-label="Ask by voice">&#127908;</button>
          <input id="agentInput" placeholder="How do I change a rack and pinion?" autocomplete="off">
          <button class="button button-gold button-compact" type="submit" id="agentSend">Ask</button>
        </form>
      </div>`;
    document.body.appendChild(panel);

    panel.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeChat();
    });
    panel.querySelector("#agentClose").addEventListener("click", closeChat);
    panel.querySelector("#agentComposer").addEventListener("submit", (event) => {
      event.preventDefault();
      const input = panel.querySelector("#agentInput");
      const question = input.value.trim();
      if (!question) return;
      input.value = "";
      void ask(question);
    });
    panel.querySelector("#agentMic").addEventListener("click", () => {
      // Unlock audio inside the tap itself — iOS ignores any later attempt.
      window.GMMVoice?.prime();
      void askByVoice();
    });
    panel.querySelector("#agentSpeakToggle").addEventListener("click", (event) => {
      speakReplies = !speakReplies;
      event.currentTarget.setAttribute("aria-pressed", String(speakReplies));
      event.currentTarget.textContent = `Read aloud: ${speakReplies ? "on" : "off"}`;
      if (speakReplies) window.GMMVoice?.prime();
    });
    return panel;
  }

  function appendBubble(role, text, videos) {
    const thread = panel.querySelector("#agentThread");
    const wrap = document.createElement("div");
    wrap.className = `agent-bubble agent-${role}`;
    wrap.innerHTML = `<p>${escapeHtml(String(text || "").trim()).replace(/\n+/g, "</p><p>")}</p>`;
    if (Array.isArray(videos) && videos.length) {
      const rail = document.createElement("div");
      rail.className = "agent-videos";
      rail.innerHTML = videos.map((video) => `
        <a class="agent-video" href="${escapeHtml(video.url)}" target="_blank" rel="noopener noreferrer">
          <img src="https://i.ytimg.com/vi/${escapeHtml(video.id)}/mqdefault.jpg" alt="" loading="lazy" width="320" height="180">
          <span class="agent-video-play" aria-hidden="true">&#9654;</span>
          <span class="agent-video-label">Watch it</span>
        </a>`).join("");
      wrap.appendChild(rail);
    }
    thread.appendChild(wrap);
    thread.scrollTop = thread.scrollHeight;
    return wrap;
  }

  /** What she did to the job, shown as its own line so it is never missed. */
  function appendReceipt(lines) {
    if (!lines.length) return;
    const thread = panel.querySelector("#agentThread");
    const row = document.createElement("div");
    row.className = "agent-did";
    row.innerHTML = lines.map((line) => `<span>${escapeHtml(line)}</span>`).join("");
    thread.appendChild(row);
    thread.scrollTop = thread.scrollHeight;
  }

  function setChatBusy(busy) {
    chatBusy = busy;
    panel.querySelector("#agentSend").disabled = busy;
    panel.querySelector("#agentMic").disabled = busy;
  }

  /**
   * One question, and however many rounds of doing-things it takes to answer.
   *
   * A job-changing call comes back unexecuted; it is applied here through the
   * bridge and answered with a tool result, which is what lets her say "you're
   * on the clock" only after the clock is actually running.
   */
  async function ask(question) {
    if (chatBusy) return;
    appendBubble("user", question);
    chatMessages.push({ role: "user", content: question });
    setChatBusy(true);
    const pending = appendBubble("agent", "Looking it up…");
    const sentCount = chatMessages.length;

    try {
      for (let round = 0; round < MAX_ACTION_ROUNDS; round += 1) {
        const reply = await post("/api/assistant/chat", {
          messages: chatMessages,
          job: bridge().jobContext?.() || null
        });

        const actions = Array.isArray(reply.actions) ? reply.actions : [];
        if (!actions.length) {
          const say = String(reply.say || "").trim() || "I couldn't find anything on that.";
          pending.remove();
          appendBubble("agent", say, reply.videos);
          chatMessages.push({ role: "assistant", content: say });
          if (speakReplies) {
            // Capped: the Worker's text-to-speech route refuses a long line, and
            // he wants the answer, not the whole write-up read at him.
            void window.GMMVoice?.speak(say.slice(0, 700));
          }
          return;
        }

        // The turn that carried the calls has to come back with them, or the
        // API cannot match a result to its call. Without it, stop rather than
        // send a request that would be refused outright.
        if (!Array.isArray(reply.assistant)) {
          pending.remove();
          appendBubble("agent", String(reply.say || "").trim() || "That didn't come back right.");
          return;
        }

        // Anything she said on the way to acting still belongs on screen.
        if (reply.say) appendBubble("agent", reply.say, reply.videos);

        const results = [];
        const receipts = [];
        for (const action of actions) {
          const outcome = bridge().runAction?.(action.name, action.input || {})
            || { ok: false, message: "That isn't something this app can do." };
          receipts.push(`${outcome.ok ? "✓" : "—"} ${outcome.message}`);
          results.push({
            type: "tool_result",
            tool_use_id: action.id,
            content: outcome.message,
            // A refusal goes back as an error so she says what actually
            // happened instead of reporting a clock-in that never started.
            ...(outcome.ok ? {} : { is_error: true })
          });
        }
        appendReceipt(receipts);

        // Echoed verbatim: the API matches each result to the call by id.
        chatMessages.push({ role: "assistant", content: reply.assistant });
        chatMessages.push({ role: "user", content: results });
      }

      pending.remove();
      appendBubble("agent", "That went round in circles. Ask me again?");
    } catch (error) {
      pending.remove();
      appendBubble("agent", error.status === 503
        ? `${AGENT_NAME} isn't switched on yet.`
        : error.message || "That didn't go through.");
      // The failed exchange is dropped so the next question is not sent with a
      // half-finished turn hanging off the end of it.
      chatMessages.length = sentCount - 1;
    } finally {
      setChatBusy(false);
    }
  }

  /** One spoken question, typed into the composer so he can see what it heard. */
  async function askByVoice() {
    if (chatBusy) return;
    const input = panel.querySelector("#agentInput");
    const outcome = await window.GMMVoice.run(Object.assign(
      async ({ listen, setState }) => {
        setState("listening", "What do you need?");
        return listen("long");
      },
      { farewell: null }
    ));
    const heard = String(outcome?.result || "").trim();
    if (!heard) return;
    input.value = heard;
    void ask(heard);
  }

  function openChat() {
    buildPanel();
    const context = bridge().jobContext?.() || null;
    const vehicle = context
      ? [context.vehicleYear, context.vehicleMake, context.vehicleModel].filter(Boolean).join(" ")
      : "";
    // Opening on a different car starts a new thread. Carrying the last
    // vehicle's conversation over is how a Silverado torque spec ends up being
    // answered for a Suburban.
    if (chatVehicle !== null && chatVehicle !== vehicle) resetChat();
    chatVehicle = vehicle;
    panel.querySelector("#agentVehicle").textContent = vehicle || "Ask anything";
    if (!chatMessages.length) {
      appendBubble("agent", vehicle
        ? `On the ${vehicle}. Ask me how to do something and I'll find you a video first. I can clock you in and put notes on the invoice too — just say so.`
        : `Ask me how to do something and I'll find you a video first, then walk it through. Tell me the year, make and model so the specs are right.`);
    }
    if (!panel.open) panel.showModal();
    panel.querySelector("#agentInput").focus();
  }

  function closeChat() {
    if (panel?.open) panel.close();
  }

  function resetChat() {
    chatMessages = [];
    if (panel) panel.querySelector("#agentThread").innerHTML = "";
  }

  window.GMMAgent = {
    name: AGENT_NAME,
    available,
    talkItIn,
    openChat,
    closeChat,
    resetChat
  };
})();
