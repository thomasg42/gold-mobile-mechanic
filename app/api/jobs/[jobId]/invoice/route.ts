import { apiError, getDatabase } from "../../../../../db/store";
import { getJob } from "../../../../../db/jobs";

type RouteContext = { params: Promise<{ jobId: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    const { jobId } = await context.params;
    const payload = (await request.json().catch(() => ({}))) as {
      recipientEmail?: string;
    };
    const job = await getJob(jobId);
    if (!job) {
      return Response.json({ error: "Job not found." }, { status: 404 });
    }
    if (!["completed", "invoiced"].includes(job.status)) {
      return Response.json(
        { error: "Clock out before creating the invoice." },
        { status: 409 },
      );
    }
    if (!job.receiptsReviewed) {
      return Response.json(
        { error: "Review the receipt folder before creating the invoice." },
        { status: 409 },
      );
    }

    const recipientEmail =
      payload.recipientEmail?.trim() || job.customerEmail;
    const db = await getDatabase();
    if (job.invoice) {
      await db
        .prepare(
          "UPDATE invoices SET recipient_email = ? WHERE job_id = ?",
        )
        .bind(recipientEmail, jobId)
        .run();
      await db
        .prepare(
          "UPDATE jobs SET customer_email = ?, status = 'invoiced', updated_at = ? WHERE id = ?",
        )
        .bind(recipientEmail, new Date().toISOString(), jobId)
        .run();
      return Response.json({ job: await getJob(jobId) });
    }

    const laborCents = Math.round(
      (job.workSeconds / 3600) * job.laborRateCents,
    );
    const materialsCents = job.materials.reduce(
      (sum, material) =>
        sum + material.quantity * material.unitCostCents,
      0,
    );
    const totalCents = laborCents + materialsCents;
    const day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    const invoiceNumber = `GMM-INV-${day}-${job.id.slice(-4)}`;
    const now = new Date().toISOString();

    await db.batch([
      db
        .prepare(
          "INSERT INTO invoices (id, job_id, invoice_number, labor_cents, materials_cents, total_cents, recipient_email, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?)",
        )
        .bind(
          crypto.randomUUID(),
          jobId,
          invoiceNumber,
          laborCents,
          materialsCents,
          totalCents,
          recipientEmail,
          now,
        ),
      db
        .prepare(
          "UPDATE jobs SET customer_email = ?, status = 'invoiced', updated_at = ? WHERE id = ?",
        )
        .bind(recipientEmail, now, jobId),
    ]);

    return Response.json({ job: await getJob(jobId) }, { status: 201 });
  } catch (error) {
    return apiError(error, "Could not create the invoice.");
  }
}
