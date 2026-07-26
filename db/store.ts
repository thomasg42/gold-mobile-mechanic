import { env } from "cloudflare:workers";

type MechanicEnv = {
  DB: D1Database;
  RECEIPTS: R2Bucket;
};

let schemaReady: Promise<void> | null = null;

export function getBindings(): MechanicEnv {
  const bindings = env as unknown as Partial<MechanicEnv>;
  if (!bindings.DB) {
    throw new Error("Gold Mobile Mechanic database binding is unavailable.");
  }
  if (!bindings.RECEIPTS) {
    throw new Error("Gold Mobile Mechanic receipt storage is unavailable.");
  }
  return bindings as MechanicEnv;
}

export async function getDatabase(): Promise<D1Database> {
  const { DB } = getBindings();
  schemaReady ??= initializeSchema(DB).catch((error) => {
    schemaReady = null;
    throw error;
  });
  await schemaReady;
  return DB;
}

async function initializeSchema(db: D1Database) {
  await db.batch([
    db
      .prepare(
        `CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY,
          customer_name TEXT NOT NULL,
          customer_email TEXT NOT NULL DEFAULT '',
          vehicle_year TEXT NOT NULL DEFAULT '',
          vehicle_make TEXT NOT NULL,
          vehicle_model TEXT NOT NULL,
          vehicle_plate TEXT NOT NULL DEFAULT '',
          labor_rate_cents INTEGER NOT NULL,
          agreed_work TEXT NOT NULL,
          suggestions TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'draft',
          receipts_reviewed INTEGER NOT NULL DEFAULT 0,
          started_at TEXT,
          ended_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )`,
      ),
    db
      .prepare(
        `CREATE TABLE IF NOT EXISTS time_entries (
          id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('work', 'break')),
          started_at TEXT NOT NULL,
          ended_at TEXT,
          FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
        )`,
      ),
    db
      .prepare(
        `CREATE TABLE IF NOT EXISTS materials (
          id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL,
          description TEXT NOT NULL,
          quantity INTEGER NOT NULL DEFAULT 1,
          unit_cost_cents INTEGER NOT NULL,
          FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
        )`,
      ),
    db
      .prepare(
        `CREATE TABLE IF NOT EXISTS receipts (
          id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL,
          object_key TEXT NOT NULL,
          filename TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          vendor TEXT NOT NULL DEFAULT '',
          amount_cents INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
        )`,
      ),
    db
      .prepare(
        `CREATE TABLE IF NOT EXISTS invoices (
          id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL UNIQUE,
          invoice_number TEXT NOT NULL UNIQUE,
          labor_cents INTEGER NOT NULL,
          materials_cents INTEGER NOT NULL,
          total_cents INTEGER NOT NULL,
          recipient_email TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'ready',
          created_at TEXT NOT NULL,
          FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
        )`,
      ),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS time_entries_job_idx ON time_entries(job_id)",
    ),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS materials_job_idx ON materials(job_id)",
    ),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS receipts_job_idx ON receipts(job_id)",
    ),
  ]);
}

export function apiError(error: unknown, fallback = "Something went wrong.") {
  const message = error instanceof Error ? error.message : fallback;
  console.error(error);
  return Response.json({ error: message || fallback }, { status: 500 });
}
