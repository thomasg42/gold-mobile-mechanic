CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS jobs_updated_at_idx
  ON jobs(updated_at DESC);

CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  data_base64 TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS receipts_job_id_idx
  ON receipts(job_id);
