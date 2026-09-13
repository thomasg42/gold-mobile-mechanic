/**
 * Anya — the shop agent that lives inside the mechanic app.
 *
 * Two modes, one model, one endpoint group:
 *
 *   invoice  Fills the invoice sheet by conversation. Structured JSON comes
 *            back, never prose the phone has to parse, so a misheard sentence
 *            cannot land in a customer record as if it were a value.
 *
 *   chat     A real conversation, the way ChatGPT or Claude is a conversation.
 *            She searches the web, leads with a video on a how-do-I question,
 *            and — this is the part that makes her worth talking to rather than
 *            reading — she can act on the open job: clock in, clock out, write
 *            a note onto the invoice, correct the agreed work. The mechanic
 *            talks; the ledger changes.
 *
 * The API key never leaves this Worker. The phone posts a transcript and gets
 * back a reply; it has no credential of its own, which is the whole reason the
 * proxy exists rather than calling Anthropic from the page.
 *
 * WHO RUNS WHICH TOOL. Web search runs on Anthropic's servers and never touches
 * this Worker. Every job-changing tool runs on the PHONE — they are returned to
 * the app as pending actions, applied through the same functions the buttons
 * call, and echoed back as tool results. The Worker never mutates a job. That
 * split is deliberate: the phone holds the offline queue, the sync state and
 * the undo, and a Worker reaching around it would write changes the app does
 * not know it made.
 *
 * ---------------------------------------------------------------------------
 * SAFETY RULE THAT IS NOT NEGOTIABLE
 *
 * A guessed torque spec, fluid capacity, or bolt sequence can put a wheel or a
 * steering rack on the road wrong. The chat prompt forbids stating any number
 * the model did not read from a source it searched, and requires it to say
 * plainly when it could not confirm one. Do not soften that instruction to make
 * answers feel more complete.
 * ---------------------------------------------------------------------------
 *
 * Raw fetch rather than `@anthropic-ai/sdk`, deliberately. This Worker already
 * talks to ElevenLabs the same way, a Worker is a fetch-native runtime with no
 * HTTP-timeout problem for the SDK to solve, and dropping the dependency keeps
 * the bundle and the `nodejs_compat` surface out of a live client ledger. The
 * request shapes below follow the Messages API directly.
 */
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

export interface AssistantEnv {
  /**
   * Set with `wrangler secret put ANTHROPIC_API_KEY --config wrangler.sync.jsonc`.
   * Absent, every assistant route answers 503 and the app hides the agent
   * buttons rather than presenting one that silently fails.
   */
  ANTHROPIC_API_KEY?: string;
}

/** Her name, in one place. */
export const AGENT_NAME = "Anya";

/**
 * Opus 5 rather than a cheaper tier: this reads a mechanic's half-sentence over
 * engine noise and decides whether it heard a value or a hesitation. Getting
 * that wrong writes a wrong name onto a customer's invoice, or clocks someone
 * in who only asked a question about clocking in. Effort is what is tuned for
 * cost here, not the model.
 */
const MODEL = "claude-opus-5";

/** Fields the agent is allowed to write into the invoice sheet. */
export const INVOICE_FIELDS = [
  "customerName",
  "customerPhone",
  "customerEmail",
  "vehicleYear",
  "vehicleMake",
  "vehicleModel",
  "vehiclePlate",
  "agreedWork",
  "laborRate",
] as const;

/** What the phone must have before a job can be created. Mirrors app.js. */
const MUST_KNOW = ["customerName", "vehicleMake", "vehicleModel", "agreedWork", "laborRate"];

const MAX_TURNS = 60;
const MAX_MESSAGE_CHARS = 4_000;
const MAX_BLOCKS_PER_TURN = 40;

/** Tools the PHONE runs. Anything not on this list is not a job-changing tool. */
const PHONE_TOOLS = [
  {
    name: "clock_in",
    description:
      "Start billable time on the open job. Use it the moment he says he is starting work, or says to clock him in. Refuses if he is already on the clock.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "clock_out",
    description:
      "Stop billable time on the open job. Use it when he says he is done for now, stopping, or taking a break, or says to clock him out. Does NOT finish the job or file the invoice.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "add_note",
    description:
      "Append a line to the mechanic's notes on the open job. THESE PRINT ON THE CUSTOMER'S INVOICE. Use it for anything he notices and wants recorded — a worn part he did not replace, a recommendation, a measurement, something to check next visit. Write it in his voice, as a professional note to the customer, not as a summary of your conversation.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        note: { type: "string", description: "The line to add. One or two sentences." },
      },
      required: ["note"],
      additionalProperties: false,
    },
  },
  {
    name: "set_agreed_work",
    description:
      "Replace the agreed work description on the open job — what the invoice bills against. Only when he is genuinely changing or adding to the scope, and say what you changed it to. Never use it to tidy up his wording.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        work: { type: "string", description: "The full replacement description, including what was already there." },
      },
      required: ["work"],
      additionalProperties: false,
    },
  },
] as const;

const PHONE_TOOL_NAMES = new Set(PHONE_TOOLS.map((tool) => tool.name as string));

const INVOICE_SYSTEM = `You are ${AGENT_NAME}, the shop agent inside the Gold Mobile Mechanic field app. A mobile mechanic is standing at a vehicle, phone in a pocket or on a fender, talking to you to open a work order. You are filling in the invoice sheet for him.

HOW YOU TALK
- One question at a time. Short. He has his hands full.
- Never ask for two things in one breath.
- Never read a menu of options. Ask the question.
- Plain spoken English, no lists, no markdown, no emoji. Everything you say is read out loud.

WHAT YOU MUST GET before the sheet can be saved:
- customerName — whose vehicle it is
- vehicleMake and vehicleModel — vehicleYear too if he says it
- agreedWork — what he agreed to do, in his words
- laborRate — his hourly rate in dollars

Also take, if he offers them or they are easy to ask for once the must-haves are in: customerPhone, customerEmail, vehiclePlate, and the materials list.

TAKE EVERYTHING HE GIVES YOU, NOT JUST THE ANSWER TO YOUR QUESTION
He talks the way people talk — the answer to one question arrives wrapped in three other facts. Take all of it. If he says "it's Josh's Suburban, the one with the blown struts, we're doing the exhaust clamp and I'll probably need to look at the rear brakes next time", you now have the customer, the vehicle, the agreed work, and something for the notes. Fill in every field he just handed you and ask only for what is genuinely still missing.

Anything he mentions that is not one of the fields — a part he noticed, a condition, something to check next visit, a measurement — goes in "notes". Those print on the customer's invoice, so write them as professional notes in his voice, not as a transcript of the chat.

RULES ABOUT VALUES
- Never invent a value. If you did not hear it, leave the field empty and ask.
- Never invent or suggest a labor rate, a price, or a parts cost. Pricing is the owner's decision, not yours. Ask him what the rate is and use exactly what he says.
- A name is never auto-corrected. If a name could be spelled more than one way, repeat it back and ask if that is right before you keep it.
- If he says a vehicle you already have on file (you are given the list), use the customer and vehicle details from that record instead of asking again — but say which one you matched so he can stop you.
- If he corrects something, overwrite that field and say the new value back.
- "skip" or "don't have it" on an optional field means move on, not ask again.

THE FIELDS OBJECT
Return every field key every turn. An empty string means "no change" — it never clears a field. Only put a value in a field when you actually heard it this conversation.

laborRate is a plain dollar number as a string, like "125" or "125.00" — no dollar sign, no words.

WHEN IT IS DONE
Once all five must-haves are filled, set ready to true and use "say" to read the sheet back in one or two sentences — customer, vehicle, work, rate — and ask if that is right. Do not set ready before then.

If he says to clock him in, or that he is starting work, set clockIn to true on the same turn you set ready — the job is created and the clock starts together. Otherwise leave it false.`;

const CHAT_SYSTEM = `You are ${AGENT_NAME}, the shop agent inside the Gold Mobile Mechanic field app. You are talking to a working mobile mechanic who is at a vehicle right now. Treat him as a professional: he knows how to turn a wrench, he wants the specifics for this vehicle.

This is a real conversation, not a form. He will ramble, change subject, come back to something twenty minutes later, and drop details in the middle of a question. Keep up with all of it the way a person would.

YOU CAN ACTUALLY DO THINGS, NOT JUST ANSWER
You have tools that change the open job. Use them when he asks, and use them when he plainly means them without asking:
- He says he is starting, getting to it, or "clock me in" — clock_in.
- He says he is done for now, stopping, breaking for lunch, or "clock me out" — clock_out.
- He notices anything worth recording — a worn part he is not replacing, a recommendation, a measurement, something to check next time — add_note. These print on the customer's invoice.
- The scope genuinely changes or grows — set_agreed_work.

Rules about acting:
- Say what you did, in one short clause. "You're on the clock." "Noted on the invoice."
- Do not ask permission for a clock-in he just asked for. Do it.
- DO ask first if you are about to overwrite the agreed work with something meaningfully different from what is already there.
- If he is asking a QUESTION about clocking in rather than telling you to do it, answer the question. "Am I clocked in?" is not an instruction.
- Never clock him in to make a conversation tidy. Time on a clock is money on a customer's invoice.

VIDEO FIRST ON A HOW-DO-I
When he asks how to do a procedure, your FIRST move is to search for a video of that procedure on that specific vehicle, and your answer LEADS with the video:

  1. "Here's a video on it" — name what the video shows and how long it is if you know.
  2. Then the way you'd actually do it, in the order he'd do it, in a few sentences.
  3. Then the parts, fluids, and any special tools he needs on hand.
  4. Then "let me know if you need anything else."

Search YouTube first for the video. Prefer a video on the same year/make/model, or the closest generation. Say plainly if the video you found is a different year or a close-enough platform — do not pass one off as the exact vehicle.

Write the full https://www.youtube.com/watch?v=... address of the video you picked into your answer. The app turns that exact address into the tappable thumbnail he sees, so a video you searched but did not name is a video he cannot open, and naming one you did not actually find gives him a dead link.

If the question is not a procedure — a torque spec, a capacity, a symptom, a code — skip the video and just answer it. Do not force a video onto a question that doesn't want one.

NUMBERS ARE SAFETY-CRITICAL. THIS IS THE RULE YOU DO NOT BEND.
- Never state a torque spec, a fluid capacity, a clearance, a tightening sequence, or a service interval that you did not read from a source you actually searched this conversation.
- If you searched and could not confirm the number for that exact vehicle, say so in those words and tell him where it is published — the factory service manual, AllData, Mitchell, the underhood label. Never round, never estimate, never offer "typically around".
- A wrong torque number on a steering or suspension fastener gets someone killed. An "I couldn't confirm that one" is always the right answer over a plausible guess.

PRICING IS NOT YOURS
Never invent or suggest a labor rate, a parts price, or what to charge. If he asks what something should cost, tell him what the part runs if you can source it, and leave the labor and the final number to him.

HOW YOU TALK
- Plain spoken English. It may be read out loud, so no markdown, no bullet characters, no headers, no emoji.
- Short. He is under a truck, not reading a manual.
- Do not re-explain what he already told you.`;

const INVOICE_SCHEMA = {
  type: "object",
  properties: {
    say: {
      type: "string",
      description: "Exactly what to speak out loud this turn. One short question, or the final read-back.",
    },
    fields: {
      type: "object",
      properties: Object.fromEntries(
        INVOICE_FIELDS.map((field) => [field, { type: "string" }]),
      ),
      required: [...INVOICE_FIELDS],
      additionalProperties: false,
      description: "Values heard so far. Empty string means no change to that field.",
    },
    materials: {
      type: "array",
      items: { type: "string" },
      description: "Approved materials, if he listed any. Empty array means no change.",
    },
    notes: {
      type: "string",
      description:
        "Anything he mentioned that is not a field — a condition, a recommendation, something to check next visit. Prints on the customer's invoice. Empty string means nothing to add.",
    },
    ready: {
      type: "boolean",
      description: "True only once all five must-have fields are filled and read back.",
    },
    clockIn: {
      type: "boolean",
      description: "True only if he said to start the clock. Applied when the job is created.",
    },
  },
  required: ["say", "fields", "materials", "notes", "ready", "clockIn"],
  additionalProperties: false,
} as const;

type ContentBlock = {
  type: string;
  text?: string;
  content?: unknown;
  name?: string;
  id?: string;
  input?: unknown;
};

type AnthropicMessage = {
  content: ContentBlock[];
  stop_reason: string | null;
};

type ChatTurn = { role: "user" | "assistant"; content: string | ContentBlock[] };

class AnthropicError extends Error {}

/**
 * Trims and validates the transcript the phone posted.
 *
 * Content may be a plain string or a list of blocks — the phone echoes back the
 * assistant turn that carried a tool call, and the tool results that answered
 * it, and those have to survive the round trip byte-for-byte or the API cannot
 * match a result to the call that asked for it.
 */
function readTurns(value: unknown): ChatTurn[] | null {
  if (!Array.isArray(value) || !value.length) return null;
  const turns: ChatTurn[] = [];
  for (const entry of value.slice(-MAX_TURNS)) {
    const role = (entry as ChatTurn)?.role;
    const content = (entry as ChatTurn)?.content;
    if (role !== "user" && role !== "assistant") return null;

    if (Array.isArray(content)) {
      if (!content.length || content.length > MAX_BLOCKS_PER_TURN) return null;
      // Block turns are never merged: a tool_result must stay in the turn that
      // answers its tool_use, and alternation already holds across a tool round
      // trip without help.
      turns.push({ role, content });
      continue;
    }

    if (typeof content !== "string") return null;
    const trimmed = content.trim().slice(0, MAX_MESSAGE_CHARS);
    if (!trimmed) continue;
    // Roles have to alternate. A turn the phone sent with nothing in it — an
    // agent reply that came back with an empty `say` — is dropped just above,
    // which would otherwise leave two user turns touching and 400 the whole
    // request. Merging keeps what was said and keeps the shape legal.
    const previous = turns[turns.length - 1];
    if (previous?.role === role && typeof previous.content === "string") {
      previous.content = `${previous.content}\n${trimmed}`.slice(0, MAX_MESSAGE_CHARS);
      continue;
    }
    turns.push({ role, content: trimmed });
  }
  while (turns.length && turns[0].role !== "user") turns.shift();
  if (!turns.length || turns[turns.length - 1].role !== "user") return null;
  return turns;
}

/** One Messages API call. Throws on anything that is not a 200. */
async function callAnthropic(
  env: AssistantEnv,
  body: Record<string, unknown>,
): Promise<AnthropicMessage> {
  const response = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY as string,
      "anthropic-version": ANTHROPIC_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: MODEL, ...body }),
  });

  if (!response.ok) {
    // Read it so the Worker log has the real reason; never return it to the phone.
    const detail = await response.text().catch(() => "");
    throw new AnthropicError(`anthropic ${response.status}: ${detail.slice(0, 500)}`);
  }

  const message = (await response.json()) as AnthropicMessage;
  if (!Array.isArray(message?.content)) {
    throw new AnthropicError("anthropic response had no content");
  }
  return message;
}

/** Collects the plain text of a finished message. */
function textOf(message: AnthropicMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => String(block.text ?? ""))
    .join("")
    .trim();
}

/**
 * Describes the vehicles already on the ledger so the agent can match "the
 * Suburban" to a real record instead of re-interviewing a returning customer.
 * Only what it needs to match — no money, no history, no receipts.
 */
function knownVehiclesBlock(vehicles: unknown): string {
  if (!Array.isArray(vehicles) || !vehicles.length) return "";
  const lines = vehicles
    .slice(0, 40)
    .map((entry) => {
      const item = entry as Record<string, unknown>;
      const parts = [item.vehicleYear, item.vehicleMake, item.vehicleModel]
        .map((value) => String(value ?? "").trim())
        .filter(Boolean)
        .join(" ");
      const name = String(item.customerName ?? "").trim();
      if (!parts && !name) return "";
      const plate = String(item.vehiclePlate ?? "").trim();
      return `- ${name || "unknown owner"}: ${parts || "vehicle not recorded"}${plate ? ` (plate ${plate})` : ""}`;
    })
    .filter(Boolean);
  if (!lines.length) return "";
  return `\n\nVEHICLES ALREADY ON THIS PHONE'S LEDGER — match against these before asking:\n${lines.join("\n")}`;
}

export type AssistantResult =
  | { ok: true; status: 200; body: unknown }
  | { ok: false; status: number; body: { error: string } };

/**
 * invoice mode — one conversational turn that returns fields for the sheet.
 *
 * Structured output rather than a tool round-trip: the phone gets JSON it can
 * write straight into the form inputs, and there is no second network hop in
 * the middle of a spoken turn where a mechanic is standing there waiting.
 */
export async function invoiceTurn(
  env: AssistantEnv,
  payload: Record<string, unknown>,
): Promise<AssistantResult> {
  const turns = readTurns(payload.messages);
  if (!turns) {
    return { ok: false, status: 400, body: { error: "Nothing to answer." } };
  }

  const message = await callAnthropic(env, {
    max_tokens: 2_000,
    // Low effort: this is short-turn extraction, not analysis. Thinking stays
    // ON — disabling it on Opus 5 lets tool-shaped text leak into the reply,
    // which here would mean a question the mechanic hears twice.
    output_config: {
      effort: "low",
      format: { type: "json_schema", schema: INVOICE_SCHEMA },
    },
    system: [
      {
        type: "text",
        text: INVOICE_SYSTEM,
        // The prompt is byte-stable across every turn of every interview, so it
        // is worth caching; the vehicle list below it is not.
        cache_control: { type: "ephemeral" },
      },
      {
        type: "text",
        text: `Today is ${new Date().toISOString().slice(0, 10)}.${knownVehiclesBlock(payload.vehicles)}`,
      },
    ],
    messages: turns,
  });

  if (message.stop_reason === "refusal") {
    return { ok: false, status: 502, body: { error: "The agent declined that one. Fill it in by hand." } };
  }

  const raw = textOf(message);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { ok: false, status: 502, body: { error: "The agent's answer did not come back readable." } };
  }

  const fields: Record<string, string> = {};
  const given = (parsed.fields ?? {}) as Record<string, unknown>;
  for (const field of INVOICE_FIELDS) {
    const value = String(given[field] ?? "").trim();
    if (value) fields[field] = value;
  }

  const materials = Array.isArray(parsed.materials)
    ? parsed.materials.map((item) => String(item ?? "").trim()).filter(Boolean)
    : [];

  // `ready` is the agent's opinion; the must-know list is the app's rule. The
  // rule wins, so a confident-sounding turn can never open a job on a sheet
  // that is still missing the rate.
  const heard = { ...((payload.filled ?? {}) as Record<string, unknown>), ...fields };
  const complete = MUST_KNOW.every((field) => String(heard[field] ?? "").trim());
  const ready = parsed.ready === true && complete;

  return {
    ok: true,
    status: 200,
    body: {
      say: String(parsed.say ?? "").trim(),
      fields,
      materials,
      notes: String(parsed.notes ?? "").trim(),
      ready,
      // A clock cannot start on a job that was not created, so this rides with
      // `ready` rather than standing on its own.
      clockIn: ready && parsed.clockIn === true,
      missing: MUST_KNOW.filter((field) => !String(heard[field] ?? "").trim()),
    },
  };
}

/** A YouTube watch URL found in the answer or in what the agent searched. */
function youTubeIds(text: string): string[] {
  const found = new Set<string>();
  const pattern = /(?:youtube\.com\/(?:watch\?(?:[^\s"']*&)?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) found.add(match[1]);
  return [...found];
}

/** Tells the agent what job it is standing in front of. */
function jobContextBlock(job: unknown): string {
  const item = (job ?? {}) as Record<string, unknown>;
  const vehicle = [item.vehicleYear, item.vehicleMake, item.vehicleModel]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean)
    .join(" ");
  if (!vehicle && !item.customerName) {
    return "No job is open on his screen right now. You cannot clock in, clock out, or write a note until one is — say so plainly if he asks for any of those. Ask which year, make and model before giving any specification.";
  }
  const status = item.status === "in_progress"
    ? "ON THE CLOCK right now"
    : item.status === "clocked_out"
      ? "clocked out"
      : item.status === "invoiced"
        ? "invoice already filed — the job is locked, tell him to unsubmit it before changing anything"
        : "not started yet";
  return [
    `He has a job open: ${String(item.customerName ?? "owner not recorded")}, ${vehicle || "vehicle not recorded"}.`,
    `Clock status: ${status}.`,
    item.agreedWork ? `Agreed work: ${String(item.agreedWork).slice(0, 600)}` : "",
    item.suggestions ? `Notes already on it: ${String(item.suggestions).slice(0, 600)}` : "",
    "Assume every question is about this vehicle unless he names another.",
  ].filter(Boolean).join("\n");
}

/**
 * chat mode — a real conversation that can act on the open job.
 *
 * The agentic loop runs partly here and partly on the phone. Web search is a
 * server-side tool, so it resolves here without the phone knowing; a
 * job-changing tool is returned UNEXECUTED as a pending action, because only
 * the phone can apply it through the same path a button uses. `pause_turn` is
 * handled explicitly — left unhandled it returns a half-finished answer with no
 * error, which reads as the agent trailing off mid-sentence.
 */
export async function chatTurn(
  env: AssistantEnv,
  payload: Record<string, unknown>,
): Promise<AssistantResult> {
  const messages = readTurns(payload.messages);
  if (!messages) {
    return { ok: false, status: 400, body: { error: "Nothing to answer." } };
  }

  let message: AnthropicMessage | null = null;

  // Enough passes for a search, a pause-resume, and the write-up. A phone tool
  // ends the loop by returning, so this never spins on one.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    message = await callAnthropic(env, {
      max_tokens: 8_000,
      output_config: { effort: "medium" },
      system: [
        { type: "text", text: CHAT_SYSTEM, cache_control: { type: "ephemeral" } },
        { type: "text", text: jobContextBlock(payload.job) },
      ],
      tools: [
        { type: "web_search_20260209", name: "web_search", max_uses: 6 },
        ...PHONE_TOOLS,
      ],
      messages,
    });
    if (message.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: message.content });
  }

  if (!message) {
    return { ok: false, status: 502, body: { error: "The agent did not answer." } };
  }
  if (message.stop_reason === "refusal") {
    return { ok: false, status: 502, body: { error: "The agent declined that one." } };
  }

  const say = textOf(message);

  // The video it NAMED wins outright. Falling back to whatever YouTube link
  // happened to appear in the search results is how a mechanic ends up tapping
  // a thumbnail for a different job than the one just explained to him — so the
  // fallback only runs when the answer named nothing at all.
  //
  // Either way the id comes from a URL the model actually saw. None is
  // constructed here: a made-up video id renders as a dead player.
  const searched: string[] = [];
  for (const block of message.content) {
    if (block.type !== "web_search_tool_result") continue;
    const content = block.content;
    if (!Array.isArray(content)) continue; // An error result is an object, not a list.
    for (const result of content) {
      const url = String((result as { url?: unknown })?.url ?? "");
      const title = String((result as { title?: unknown })?.title ?? "");
      if (url) searched.push(`${url} ${title}`);
    }
  }
  const named = youTubeIds(say);
  const ids = named.length ? named : youTubeIds(searched.join("\n"));

  // Job-changing calls go back unexecuted. The phone applies them and posts the
  // results, which is when the conversation continues.
  const actions = message.content
    .filter((block) => block.type === "tool_use" && PHONE_TOOL_NAMES.has(String(block.name)))
    .map((block) => ({ id: String(block.id), name: String(block.name), input: block.input ?? {} }));

  return {
    ok: true,
    status: 200,
    body: {
      say,
      videos: ids.slice(0, 3).map((id) => ({ id, url: `https://www.youtube.com/watch?v=${id}` })),
      actions,
      // Echoed back verbatim on the next turn so the API can match each result
      // to the call that asked for it.
      assistant: actions.length ? message.content : null,
      truncated: message.stop_reason === "max_tokens" || message.stop_reason === "pause_turn",
    },
  };
}
