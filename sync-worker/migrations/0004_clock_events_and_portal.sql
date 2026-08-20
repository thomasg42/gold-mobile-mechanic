-- Every clock in / clock out lands here as its own immutable row the instant it
-- is tapped, so a timestamped event survives even if the whole-job PUT that
-- follows it never lands (dead signal, closed tab, storage quota error).
CREATE TABLE IF NOT EXISTS job_events (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  action TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS job_events_job_id_idx
  ON job_events(job_id, occurred_at);

-- Sign-in is a phone number against a small table, so it needs its own
-- throttle. Same shape as voice_usage.
CREATE TABLE IF NOT EXISTS portal_rate (
  bucket TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS portal_rate_expires_at_idx
  ON portal_rate(expires_at);
