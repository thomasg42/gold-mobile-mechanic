interface Env {
  DB: D1Database;
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
    "Access-Control-Allow-Methods": "GET, PUT, DELETE, OPTIONS",
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
      return json(request, { ok: true, service: "gold-mobile-mechanic-sync" });
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
