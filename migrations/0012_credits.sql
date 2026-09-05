-- Money a client already holds with a vendor.
--
-- Future cruise deposits, future cruise credits, refunds taken as credit, a
-- goodwill certificate after a bad sailing. All the same shape: an amount, the
-- vendor holding it, the client it belongs to, and an expiry after which it is
-- worth nothing.
--
-- The expiry is the point. This is money the client has already spent that
-- evaporates in silence, and it is the advisor, not the vendor, who is
-- expected to remember.

CREATE TABLE IF NOT EXISTS client_credits (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  client_name  TEXT NOT NULL,
  contact_id   TEXT,
  vendor       TEXT,
  kind         TEXT NOT NULL DEFAULT 'credit',  -- 'credit' | 'deposit' | 'certificate'
  reference    TEXT,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  issued_on    TEXT,
  expires_on   TEXT,
  used_on      TEXT,
  booking_id   TEXT,          -- the reservation it was eventually put towards
  notes        TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_credits_open ON client_credits (user_id, used_on, expires_on);
