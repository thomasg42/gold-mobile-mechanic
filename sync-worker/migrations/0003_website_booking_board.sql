CREATE TABLE IF NOT EXISTS website_bookings (
  day TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS website_bookings_created_at_idx
  ON website_bookings(created_at DESC);

CREATE TABLE IF NOT EXISTS website_booking_rate (
  bucket TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS website_booking_rate_expires_at_idx
  ON website_booking_rate(expires_at);
