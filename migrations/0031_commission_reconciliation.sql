-- What the vendor actually paid, against what was expected.
--
-- Until now a reservation carried one commission figure and a status of
-- pending, invoiced or paid, and "paid" meant somebody had ticked it. The
-- amount received was assumed to equal the amount expected, so a vendor paying
-- short was invisible: the reservation looked settled, the report counted the
-- full figure, and the difference was quietly absorbed. That is the one gap in
-- this system that costs real money rather than time.
--
-- Two tables, because reconciliation has two halves. A vendor sends one
-- statement covering many reservations, and each line on it is money against
-- one reservation. Matching the lines to reservations is the work; the
-- statement total is what proves the matching is complete.

CREATE TABLE IF NOT EXISTS commission_statements (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  vendor_id      TEXT,
  vendor_name    TEXT NOT NULL,
  reference      TEXT,              -- the vendor's own statement or cheque number
  statement_date TEXT,              -- ISO day
  -- What the vendor says they paid. Held separately from the sum of the lines
  -- on purpose: the gap between the two is the whole point of the exercise.
  total_cents    INTEGER NOT NULL DEFAULT 0,
  notes          TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_comm_stmt_user ON commission_statements (user_id, statement_date);

CREATE TABLE IF NOT EXISTS commission_receipts (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  booking_id   TEXT NOT NULL,
  -- Null when money arrives without a statement, which happens. A receipt is
  -- still a receipt; it is just harder to prove.
  statement_id TEXT,
  amount_cents INTEGER NOT NULL,
  received_on  TEXT,                -- ISO day
  reference    TEXT,
  notes        TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  FOREIGN KEY (booking_id) REFERENCES bookings (id) ON DELETE CASCADE,
  FOREIGN KEY (statement_id) REFERENCES commission_statements (id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_comm_rcpt_booking ON commission_receipts (booking_id);
CREATE INDEX IF NOT EXISTS idx_comm_rcpt_user ON commission_receipts (user_id, received_on);
CREATE INDEX IF NOT EXISTS idx_comm_rcpt_stmt ON commission_receipts (statement_id);
