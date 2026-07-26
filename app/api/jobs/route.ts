import { apiError, getDatabase } from "../../../db/store";
import { hydrateJob } from "../../../db/jobs";

type MaterialInput = {
  description?: string;
  quantity?: number;
  unitCost?: number;
};

type CreateJobPayload = {
  customerName?: string;
  customerEmail?: string;
  vehicleYear?: string;
  vehicleMake?: string;
  vehicleModel?: string;
  vehiclePlate?: string;
  laborRate?: number;
  agreedWork?: string;
  materials?: MaterialInput[];
};

function clean(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function jobNumber() {
  const day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const token = crypto.randomUUID().slice(0, 4).toUpperCase();
  return `GMM-${day}-${token}`;
}

export async function GET() {
  try {
    const db = await getDatabase();
    const rows = await db
      .prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT 100")
      .all<Record<string, unknown>>();
    const jobs = await Promise.all((rows.results ?? []).map(hydrateJob));
    return Response.json({ jobs });
  } catch (error) {
    return apiError(error, "Could not load jobs.");
  }
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as CreateJobPayload;
    const customerName = clean(payload.customerName);
    const vehicleMake = clean(payload.vehicleMake);
    const vehicleModel = clean(payload.vehicleModel);
    const agreedWork = clean(payload.agreedWork);
    const laborRate = Number(payload.laborRate);

    if (!customerName || !vehicleMake || !vehicleModel || !agreedWork) {
      return Response.json(
        {
          error:
            "Customer, vehicle make/model, and agreed work are required.",
        },
        { status: 400 },
      );
    }
    if (!Number.isFinite(laborRate) || laborRate <= 0) {
      return Response.json(
        { error: "Enter a valid hourly labor rate." },
        { status: 400 },
      );
    }

    const db = await getDatabase();
    const id = jobNumber();
    const now = new Date().toISOString();
    const materials = (payload.materials ?? [])
      .map((item) => ({
        id: crypto.randomUUID(),
        description: clean(item.description),
        quantity: Math.max(1, Math.round(Number(item.quantity) || 1)),
        unitCostCents: Math.max(
          0,
          Math.round((Number(item.unitCost) || 0) * 100),
        ),
      }))
      .filter((item) => item.description);

    const statements = [
      db
        .prepare(
          `INSERT INTO jobs (
            id, customer_name, customer_email, vehicle_year, vehicle_make,
            vehicle_model, vehicle_plate, labor_rate_cents, agreed_work,
            suggestions, status, receipts_reviewed, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', 'draft', 0, ?, ?)`,
        )
        .bind(
          id,
          customerName,
          clean(payload.customerEmail),
          clean(payload.vehicleYear),
          vehicleMake,
          vehicleModel,
          clean(payload.vehiclePlate),
          Math.round(laborRate * 100),
          agreedWork,
          now,
          now,
        ),
      ...materials.map((item) =>
        db
          .prepare(
            "INSERT INTO materials (id, job_id, description, quantity, unit_cost_cents) VALUES (?, ?, ?, ?, ?)",
          )
          .bind(
            item.id,
            id,
            item.description,
            item.quantity,
            item.unitCostCents,
          ),
      ),
    ];

    await db.batch(statements);
    const row = await db
      .prepare("SELECT * FROM jobs WHERE id = ?")
      .bind(id)
      .first<Record<string, unknown>>();
    return Response.json({ job: await hydrateJob(row!) }, { status: 201 });
  } catch (error) {
    return apiError(error, "Could not create the job.");
  }
}
