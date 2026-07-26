import { getDatabase } from "./store";

export type JobRecord = {
  id: string;
  customerName: string;
  customerEmail: string;
  vehicleYear: string;
  vehicleMake: string;
  vehicleModel: string;
  vehiclePlate: string;
  laborRateCents: number;
  agreedWork: string;
  suggestions: string;
  status: "draft" | "in_progress" | "on_break" | "completed" | "invoiced";
  receiptsReviewed: boolean;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
  workSeconds: number;
  breakSeconds: number;
  materials: MaterialRecord[];
  receipts: ReceiptRecord[];
  timeEntries: TimeEntryRecord[];
  invoice: InvoiceRecord | null;
};

export type MaterialRecord = {
  id: string;
  description: string;
  quantity: number;
  unitCostCents: number;
};

export type ReceiptRecord = {
  id: string;
  filename: string;
  mimeType: string;
  vendor: string;
  amountCents: number;
  createdAt: string;
  url: string;
};

export type TimeEntryRecord = {
  id: string;
  kind: "work" | "break";
  startedAt: string;
  endedAt: string | null;
};

export type InvoiceRecord = {
  id: string;
  invoiceNumber: string;
  laborCents: number;
  materialsCents: number;
  totalCents: number;
  recipientEmail: string;
  status: string;
  createdAt: string;
};

type Row = Record<string, unknown>;

function numberValue(value: unknown) {
  return typeof value === "number" ? value : Number(value ?? 0);
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : String(value ?? "");
}

function elapsedSeconds(startedAt: string, endedAt: string | null) {
  const start = Date.parse(startedAt);
  const end = endedAt ? Date.parse(endedAt) : Date.now();
  return Math.max(0, Math.floor((end - start) / 1000));
}

export async function hydrateJob(jobRow: Row): Promise<JobRecord> {
  const db = await getDatabase();
  const jobId = stringValue(jobRow.id);
  const [timeResult, materialResult, receiptResult, invoiceRow] =
    await Promise.all([
      db
        .prepare(
          "SELECT id, kind, started_at, ended_at FROM time_entries WHERE job_id = ? ORDER BY started_at ASC",
        )
        .bind(jobId)
        .all<Row>(),
      db
        .prepare(
          "SELECT id, description, quantity, unit_cost_cents FROM materials WHERE job_id = ? ORDER BY rowid ASC",
        )
        .bind(jobId)
        .all<Row>(),
      db
        .prepare(
          "SELECT id, filename, mime_type, vendor, amount_cents, created_at FROM receipts WHERE job_id = ? ORDER BY created_at DESC",
        )
        .bind(jobId)
        .all<Row>(),
      db
        .prepare(
          "SELECT id, invoice_number, labor_cents, materials_cents, total_cents, recipient_email, status, created_at FROM invoices WHERE job_id = ? LIMIT 1",
        )
        .bind(jobId)
        .first<Row>(),
    ]);

  const timeEntries = (timeResult.results ?? []).map((row: Row) => ({
    id: stringValue(row.id),
    kind: stringValue(row.kind) as "work" | "break",
    startedAt: stringValue(row.started_at),
    endedAt: row.ended_at ? stringValue(row.ended_at) : null,
  }));

  const totals = timeEntries.reduce(
    (
      sum: { work: number; break: number },
      entry: TimeEntryRecord,
    ) => {
      sum[entry.kind] += elapsedSeconds(entry.startedAt, entry.endedAt);
      return sum;
    },
    { work: 0, break: 0 },
  );

  return {
    id: jobId,
    customerName: stringValue(jobRow.customer_name),
    customerEmail: stringValue(jobRow.customer_email),
    vehicleYear: stringValue(jobRow.vehicle_year),
    vehicleMake: stringValue(jobRow.vehicle_make),
    vehicleModel: stringValue(jobRow.vehicle_model),
    vehiclePlate: stringValue(jobRow.vehicle_plate),
    laborRateCents: numberValue(jobRow.labor_rate_cents),
    agreedWork: stringValue(jobRow.agreed_work),
    suggestions: stringValue(jobRow.suggestions),
    status: stringValue(jobRow.status) as JobRecord["status"],
    receiptsReviewed: Boolean(jobRow.receipts_reviewed),
    startedAt: jobRow.started_at ? stringValue(jobRow.started_at) : null,
    endedAt: jobRow.ended_at ? stringValue(jobRow.ended_at) : null,
    createdAt: stringValue(jobRow.created_at),
    updatedAt: stringValue(jobRow.updated_at),
    workSeconds: totals.work,
    breakSeconds: totals.break,
    materials: (materialResult.results ?? []).map((row: Row) => ({
      id: stringValue(row.id),
      description: stringValue(row.description),
      quantity: numberValue(row.quantity),
      unitCostCents: numberValue(row.unit_cost_cents),
    })),
    receipts: (receiptResult.results ?? []).map((row: Row) => ({
      id: stringValue(row.id),
      filename: stringValue(row.filename),
      mimeType: stringValue(row.mime_type),
      vendor: stringValue(row.vendor),
      amountCents: numberValue(row.amount_cents),
      createdAt: stringValue(row.created_at),
      url: `/api/receipts/${encodeURIComponent(stringValue(row.id))}`,
    })),
    timeEntries,
    invoice: invoiceRow
      ? {
          id: stringValue(invoiceRow.id),
          invoiceNumber: stringValue(invoiceRow.invoice_number),
          laborCents: numberValue(invoiceRow.labor_cents),
          materialsCents: numberValue(invoiceRow.materials_cents),
          totalCents: numberValue(invoiceRow.total_cents),
          recipientEmail: stringValue(invoiceRow.recipient_email),
          status: stringValue(invoiceRow.status),
          createdAt: stringValue(invoiceRow.created_at),
        }
      : null,
  };
}

export async function getJob(jobId: string) {
  const db = await getDatabase();
  const row = await db
    .prepare("SELECT * FROM jobs WHERE id = ? LIMIT 1")
    .bind(jobId)
    .first<Row>();
  return row ? hydrateJob(row) : null;
}
