interface Env {
  DB: D1Database;
  /**
   * Set with `wrangler secret put ELEVENLABS_API_KEY --config wrangler.sync.jsonc`.
   * When absent the voice routes return 503 and the phone falls back to the
   * browser's own speech engine, so the app keeps working either way.
   */
  ELEVENLABS_API_KEY?: string;
  /** Optional override for the spoken voice. Defaults to ELEVEN_DEFAULT_VOICE. */
  ELEVENLABS_VOICE_ID?: string;
}

type StoredJobRow = {
  data: string;
};

type StoredReceiptRow = {
  data_base64: string;
  mime_type: string;
};

const GITHUB_ORIGIN = "https://thomasg42.github.io";
const MAX_RECEIPT_BYTES = 900_000;

// Voice proxy limits. The ElevenLabs key is billable, so every route that
// spends it is capped on size and on calls-per-minute per caller.
const ELEVEN_DEFAULT_VOICE = "21m00Tcm4TlvDq8ikWAM";
const ELEVEN_TTS_MODEL = "eleven_turbo_v2_5";
const ELEVEN_STT_MODEL = "scribe_v1";
const MAX_TTS_CHARS = 800;
const MAX_STT_BYTES = 4_000_000;
const VOICE_RATE_LIMIT = 60;
const VOICE_RATE_WINDOW_SECONDS = 60;

function allowedOrigin(request: Request): string | null {
  const origin = request.headers.get("Origin");
  if (!origin) return null;
  if (origin === GITHUB_ORIGIN) return origin;
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
  return null;
}

function corsHeaders(request: Request): Headers {
  const headers = new Headers({
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  });
  const origin = allowedOrigin(request);
  if (origin) headers.set("Access-Control-Allow-Origin", origin);
  return headers;
}

function json(
  request: Request,
  payload: unknown,
  status = 200,
): Response {
  const headers = corsHeaders(request);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(payload), { status, headers });
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function jobPath(pathname: string): { jobId: string } | null {
  const match = /^\/api\/jobs\/([^/]+)$/.exec(pathname);
  return match ? { jobId: decodeURIComponent(match[1]) } : null;
}

function mergeRecordsById(
  current: Array<Record<string, unknown>>,
  incoming: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const records = new Map<string, Record<string, unknown>>();
  for (const value of [...current, ...incoming]) {
    const id = typeof value?.id === "string" ? value.id : "";
    if (!id) continue;
    const existing = records.get(id);
    records.set(id, {
      ...(existing || {}),
      ...value,
      endedAt:
        value.endedAt ??
        existing?.endedAt ??
        null,
    });
  }
  return [...records.values()];
}

function mergeJobs(
  current: Record<string, unknown> | null,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  if (!current) return incoming;
  const latestEventTime = (job: Record<string, unknown>): number => {
    if (!Array.isArray(job.eventHistory)) return Number.NaN;
    return job.eventHistory.reduce((latest: number, event: Record<string, unknown>) => {
      const occurredAt = Date.parse(String(event.occurredAt || 0));
      return Number.isFinite(occurredAt) ? Math.max(latest, occurredAt) : latest;
    }, Number.NEGATIVE_INFINITY);
  };
  const currentEventTime = latestEventTime(current);
  const incomingEventTime = latestEventTime(incoming);
  const currentTime = Date.parse(String(current.updatedAt || current.createdAt || 0));
  const incomingTime = Date.parse(String(incoming.updatedAt || incoming.createdAt || 0));
  const incomingIsNewer =
    (Number.isFinite(incomingEventTime) &&
      (!Number.isFinite(currentEventTime) || incomingEventTime > currentEventTime)) ||
    (incomingEventTime === currentEventTime &&
      (!Number.isFinite(currentTime) ||
        (Number.isFinite(incomingTime) && incomingTime >= currentTime)));
  const base = incomingIsNewer ? incoming : current;
  const eventHistory = mergeRecordsById(
    Array.isArray(current.eventHistory) ? current.eventHistory as Array<Record<string, unknown>> : [],
    Array.isArray(incoming.eventHistory) ? incoming.eventHistory as Array<Record<string, unknown>> : [],
  ).sort((a, b) => String(a.occurredAt).localeCompare(String(b.occurredAt)));
  const latestEvent = eventHistory.at(-1);
  const statusByAction: Record<string, string> = {
    clock_in: "in_progress",
    break_start: "on_break",
    break_end: "in_progress",
    clock_out: "completed",
  };
  const resolvedStatus =
    base.status === "invoiced"
      ? "invoiced"
      : statusByAction[String(latestEvent?.action || "")] || base.status;

  return {
    ...base,
    id: incoming.id,
    status: resolvedStatus,
    endedAt:
      resolvedStatus === "completed" || resolvedStatus === "invoiced"
        ? base.endedAt || latestEvent?.occurredAt || null
        : null,
    createdAt: current.createdAt || incoming.createdAt,
    materials: mergeRecordsById(
      Array.isArray(current.materials) ? current.materials as Array<Record<string, unknown>> : [],
      Array.isArray(incoming.materials) ? incoming.materials as Array<Record<string, unknown>> : [],
    ),
    timeEntries: mergeRecordsById(
      Array.isArray(current.timeEntries) ? current.timeEntries as Array<Record<string, unknown>> : [],
      Array.isArray(incoming.timeEntries) ? incoming.timeEntries as Array<Record<string, unknown>> : [],
    ).sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt))),
    eventHistory,
    receipts: mergeRecordsById(
      Array.isArray(current.receipts) ? current.receipts as Array<Record<string, unknown>> : [],
      Array.isArray(incoming.receipts) ? incoming.receipts as Array<Record<string, unknown>> : [],
    ),
  };
}

function receiptPath(
  pathname: string,
): { jobId: string; receiptId: string } | null {
  const match = /^\/api\/jobs\/([^/]+)\/receipts\/([^/]+)$/.exec(pathname);
  return match
    ? {
        jobId: decodeURIComponent(match[1]),
        receiptId: decodeURIComponent(match[2]),
      }
    : null;
}

async function listJobs(request: Request, env: Env): Promise<Response> {
  const result = await env.DB.prepare(
    "SELECT data FROM jobs ORDER BY updated_at DESC",
  ).all<StoredJobRow>();
  const jobs = (result.results || []).flatMap((row) => {
    try {
      return [JSON.parse(row.data)];
    } catch {
      return [];
    }
  });
  return json(request, { jobs, serverTime: new Date().toISOString() });
}

async function putJob(
  request: Request,
  env: Env,
  jobId: string,
): Promise<Response> {
  let job: Record<string, unknown>;
  try {
    job = (await request.json()) as Record<string, unknown>;
  } catch {
    return json(request, { error: "Job body must be valid JSON." }, 400);
  }

  if (!job || job.id !== jobId || !job.customerName || !job.status) {
    return json(request, { error: "Job identity and required fields are invalid." }, 400);
  }

  const existingRow = await env.DB.prepare("SELECT data FROM jobs WHERE id = ?")
    .bind(jobId)
    .first<StoredJobRow>();
  let existing: Record<string, unknown> | null = null;
  if (existingRow?.data) {
    try {
      existing = JSON.parse(existingRow.data) as Record<string, unknown>;
    } catch {
      existing = null;
    }
  }

  job = mergeJobs(existing, job);
  const updatedAt = new Date().toISOString();
  job.updatedAt = updatedAt;
  await env.DB.prepare(
    `INSERT INTO jobs (id, data, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       data = excluded.data,
       updated_at = excluded.updated_at`,
  )
    .bind(jobId, JSON.stringify(job), updatedAt)
    .run();

  return json(request, { job, updatedAt });
}

async function deleteJob(
  request: Request,
  env: Env,
  jobId: string,
): Promise<Response> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM receipts WHERE job_id = ?").bind(jobId),
    env.DB.prepare("DELETE FROM jobs WHERE id = ?").bind(jobId),
  ]);
  return json(request, { deleted: true, jobId });
}

async function putReceipt(
  request: Request,
  env: Env,
  jobId: string,
  receiptId: string,
): Promise<Response> {
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > MAX_RECEIPT_BYTES) {
    return json(request, { error: "Receipt image exceeds the 900 KB sync limit." }, 413);
  }

  const buffer = await request.arrayBuffer();
  if (!buffer.byteLength || buffer.byteLength > MAX_RECEIPT_BYTES) {
    return json(request, { error: "Receipt image is empty or too large." }, 413);
  }

  const mimeType = request.headers.get("Content-Type") || "image/jpeg";
  if (!mimeType.startsWith("image/")) {
    return json(request, { error: "Receipt must be an image." }, 415);
  }

  const exists = await env.DB.prepare("SELECT id FROM jobs WHERE id = ?")
    .bind(jobId)
    .first();
  if (!exists) {
    return json(request, { error: "Save the job before uploading its receipt." }, 409);
  }

  const updatedAt = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO receipts (id, job_id, mime_type, data_base64, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       job_id = excluded.job_id,
       mime_type = excluded.mime_type,
       data_base64 = excluded.data_base64,
       updated_at = excluded.updated_at`,
  )
    .bind(
      receiptId,
      jobId,
      mimeType,
      arrayBufferToBase64(buffer),
      updatedAt,
    )
    .run();

  return json(request, { id: receiptId, jobId, updatedAt }, 201);
}

async function getReceipt(
  request: Request,
  env: Env,
  jobId: string,
  receiptId: string,
): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT mime_type, data_base64
     FROM receipts
     WHERE id = ? AND job_id = ?`,
  )
    .bind(receiptId, jobId)
    .first<StoredReceiptRow>();

  if (!row) return json(request, { error: "Receipt not found." }, 404);

  const headers = corsHeaders(request);
  headers.set("Content-Type", row.mime_type);
  headers.set("Cache-Control", "private, no-store");
  return new Response(base64ToBytes(row.data_base64), { headers });
}

/**
 * Per-caller call ceiling for the billable voice routes. A single interview is
 * roughly a dozen calls, so the limit only ever trips on a runaway loop or an
 * outright abuse attempt — either of which would spend real ElevenLabs credit.
 */
async function withinVoiceRateLimit(request: Request, env: Env): Promise<boolean> {
  const caller = request.headers.get("CF-Connecting-IP") || "unknown";
  const nowSeconds = Math.floor(Date.now() / 1000);
  const window = Math.floor(nowSeconds / VOICE_RATE_WINDOW_SECONDS);
  const bucket = `${caller}|${window}`;
  const expiresAt = (window + 1) * VOICE_RATE_WINDOW_SECONDS;
  try {
    const row = await env.DB.prepare(
      `INSERT INTO voice_usage (bucket, count, expires_at) VALUES (?1, 1, ?2)
       ON CONFLICT(bucket) DO UPDATE SET count = count + 1
       RETURNING count`,
    )
      .bind(bucket, expiresAt)
      .first<{ count: number }>();
    // Opportunistic sweep so the table cannot grow without bound.
    if ((row?.count ?? 0) === 1) {
      await env.DB.prepare(`DELETE FROM voice_usage WHERE expires_at < ?1`)
        .bind(nowSeconds)
        .run();
    }
    return (row?.count ?? 0) <= VOICE_RATE_LIMIT;
  } catch {
    // A limiter outage must not take the feature down with it.
    return true;
  }
}

async function speakText(request: Request, env: Env): Promise<Response> {
  if (!env.ELEVENLABS_API_KEY) {
    return json(request, { error: "Voice is not configured." }, 503);
  }
  let text = "";
  try {
    const payload = (await request.json()) as { text?: unknown };
    text = typeof payload?.text === "string" ? payload.text.trim() : "";
  } catch {
    return json(request, { error: "Send JSON with a text field." }, 400);
  }
  if (!text) return json(request, { error: "Nothing to say." }, 400);
  if (text.length > MAX_TTS_CHARS) {
    return json(request, { error: "That line is too long to speak." }, 413);
  }
  if (!(await withinVoiceRateLimit(request, env))) {
    return json(request, { error: "Voice is busy. Try again in a moment." }, 429);
  }

  const voiceId = env.ELEVENLABS_VOICE_ID || ELEVEN_DEFAULT_VOICE;
  const upstream = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_64`,
    {
      method: "POST",
      headers: {
        "xi-api-key": env.ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({ text, model_id: ELEVEN_TTS_MODEL }),
    },
  );

  if (!upstream.ok) {
    // Never surface the upstream body — it can echo account detail.
    return json(request, { error: "Voice service is unavailable." }, 502);
  }

  const headers = corsHeaders(request);
  headers.set("Content-Type", "audio/mpeg");
  headers.set("Cache-Control", "no-store");
  return new Response(upstream.body, { status: 200, headers });
}

async function transcribeAudio(request: Request, env: Env): Promise<Response> {
  if (!env.ELEVENLABS_API_KEY) {
    return json(request, { error: "Voice is not configured." }, 503);
  }
  const audio = await request.arrayBuffer();
  if (!audio.byteLength) return json(request, { error: "No audio received." }, 400);
  if (audio.byteLength > MAX_STT_BYTES) {
    return json(request, { error: "That clip is too long." }, 413);
  }
  if (!(await withinVoiceRateLimit(request, env))) {
    return json(request, { error: "Voice is busy. Try again in a moment." }, 429);
  }

  const mimeType = request.headers.get("Content-Type") || "audio/webm";
  const form = new FormData();
  form.append("file", new Blob([audio], { type: mimeType }), "speech");
  form.append("model_id", ELEVEN_STT_MODEL);

  const upstream = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": env.ELEVENLABS_API_KEY },
    body: form,
  });

  if (!upstream.ok) {
    return json(request, { error: "Voice service is unavailable." }, 502);
  }

  const result = (await upstream.json()) as { text?: unknown };
  return json(request, { text: typeof result?.text === "string" ? result.text : "" });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      if (request.headers.get("Origin") && !allowedOrigin(request)) {
        return new Response(null, { status: 403 });
      }
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    if (url.pathname === "/api/health" && request.method === "GET") {
      return json(request, {
        ok: true,
        service: "gold-mobile-mechanic-sync",
        voice: Boolean(env.ELEVENLABS_API_KEY),
      });
    }

    // The voice routes spend real ElevenLabs credit, so unlike the sync routes
    // they refuse anything that is not the app's own origin.
    if (url.pathname.startsWith("/api/voice/")) {
      if (!allowedOrigin(request)) {
        return json(request, { error: "Forbidden." }, 403);
      }
      if (url.pathname === "/api/voice/tts" && request.method === "POST") {
        return speakText(request, env);
      }
      if (url.pathname === "/api/voice/stt" && request.method === "POST") {
        return transcribeAudio(request, env);
      }
      return json(request, { error: "Not found." }, 404);
    }

    if (url.pathname === "/api/jobs" && request.method === "GET") {
      return listJobs(request, env);
    }

    const receipt = receiptPath(url.pathname);
    if (receipt && request.method === "PUT") {
      return putReceipt(request, env, receipt.jobId, receipt.receiptId);
    }
    if (receipt && request.method === "GET") {
      return getReceipt(request, env, receipt.jobId, receipt.receiptId);
    }

    const job = jobPath(url.pathname);
    if (job && request.method === "PUT") {
      return putJob(request, env, job.jobId);
    }
    if (job && request.method === "DELETE") {
      return deleteJob(request, env, job.jobId);
    }

    return json(request, { error: "Not found." }, 404);
  },
} satisfies ExportedHandler<Env>;
