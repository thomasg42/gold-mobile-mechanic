CREATE TABLE IF NOT EXISTS voice_usage (
  bucket TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS voice_usage_expires_at_idx
  ON voice_usage(expires_at);
