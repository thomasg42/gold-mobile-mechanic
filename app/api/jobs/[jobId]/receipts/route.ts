import { apiError, getBindings, getDatabase } from "../../../../../db/store";
import { getJob } from "../../../../../db/jobs";

type RouteContext = { params: Promise<{ jobId: string }> };

function safeFilename(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .slice(-80);
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { jobId } = await context.params;
    const job = await getJob(jobId);
    if (!job) {
      return Response.json({ error: "Job not found." }, { status: 404 });
    }

    const form = await request.formData();
    const file = form.get("receipt");
    const vendor = String(form.get("vendor") ?? "").trim();
    const amount = Number(form.get("amount") ?? 0);

    if (!(file instanceof File) || !file.type.startsWith("image/")) {
      return Response.json(
        { error: "Take or choose a receipt image." },
        { status: 400 },
      );
    }
    if (file.size > 10 * 1024 * 1024) {
      return Response.json(
        { error: "Receipt images must be smaller than 10 MB." },
        { status: 413 },
      );
    }

    const id = crypto.randomUUID();
    const filename = safeFilename(file.name || `receipt-${id}.jpg`);
    const objectKey = `jobs/${jobId}/receipts/${id}-${filename}`;
    const { RECEIPTS } = getBindings();
    await RECEIPTS.put(objectKey, file.stream(), {
      httpMetadata: { contentType: file.type },
      customMetadata: { jobId, receiptId: id },
    });

    const db = await getDatabase();
    await db
      .prepare(
        "INSERT INTO receipts (id, job_id, object_key, filename, mime_type, vendor, amount_cents, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        id,
        jobId,
        objectKey,
        filename,
        file.type,
        vendor,
        Math.max(0, Math.round((Number.isFinite(amount) ? amount : 0) * 100)),
        new Date().toISOString(),
      )
      .run();
    await db
      .prepare(
        "UPDATE jobs SET receipts_reviewed = 0, updated_at = ? WHERE id = ?",
      )
      .bind(new Date().toISOString(), jobId)
      .run();

    return Response.json({ job: await getJob(jobId) }, { status: 201 });
  } catch (error) {
    return apiError(error, "Could not save the receipt.");
  }
}
