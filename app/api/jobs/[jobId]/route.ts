import { apiError, getDatabase } from "../../../../db/store";
import { getJob } from "../../../../db/jobs";

type RouteContext = { params: Promise<{ jobId: string }> };

export async function GET(_: Request, context: RouteContext) {
  try {
    const { jobId } = await context.params;
    const job = await getJob(jobId);
    if (!job) {
      return Response.json({ error: "Job not found." }, { status: 404 });
    }
    return Response.json({ job });
  } catch (error) {
    return apiError(error, "Could not load the job.");
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const { jobId } = await context.params;
    const payload = (await request.json()) as {
      suggestions?: string;
      customerEmail?: string;
      receiptsReviewed?: boolean;
    };
    const updates: string[] = [];
    const values: unknown[] = [];

    if (typeof payload.suggestions === "string") {
      updates.push("suggestions = ?");
      values.push(payload.suggestions.trim());
    }
    if (typeof payload.customerEmail === "string") {
      updates.push("customer_email = ?");
      values.push(payload.customerEmail.trim());
    }
    if (typeof payload.receiptsReviewed === "boolean") {
      updates.push("receipts_reviewed = ?");
      values.push(payload.receiptsReviewed ? 1 : 0);
    }
    if (!updates.length) {
      return Response.json({ error: "No supported changes supplied." }, { status: 400 });
    }

    updates.push("updated_at = ?");
    values.push(new Date().toISOString(), jobId);
    const db = await getDatabase();
    const result = await db
      .prepare(`UPDATE jobs SET ${updates.join(", ")} WHERE id = ?`)
      .bind(...values)
      .run();
    if (!result.meta.changes) {
      return Response.json({ error: "Job not found." }, { status: 404 });
    }
    return Response.json({ job: await getJob(jobId) });
  } catch (error) {
    return apiError(error, "Could not save the job.");
  }
}
