-- iTabs Orders: one row per order. "data" holds the full order JSON as the staff screen sees it.
CREATE TABLE IF NOT EXISTS orders (
  order_id   TEXT PRIMARY KEY,
  status     TEXT NOT NULL,
  sort_key   TEXT NOT NULL,     -- created_at from the cafe page, or received_at
  expires_at INTEGER NOT NULL,  -- epoch ms; 7 days, or 1 day once Done
  data       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS orders_live ON orders (expires_at, sort_key);
