-- Travel payment schedules.
--
-- Bookings recorded a deposit date and a final payment date but nothing about
-- money actually received, so the portal could not answer the question that
-- matters most day to day: what has this client paid, and what do they still
-- owe.
--
-- One table holds both sides. A row with a due date and no paid date is money
-- expected; the same row gains a paid date when it arrives. That handles
-- partial payments and rescheduling naturally, where separate "scheduled" and
-- "received" tables would need reconciling against each other.

ALTER TABLE bookings ADD COLUMN deposit_cents INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS booking_payments (
  id            TEXT PRIMARY KEY,
  booking_id    TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  -- deposit | installment | final | refund
  kind          TEXT NOT NULL DEFAULT 'installment',
  amount_cents  INTEGER NOT NULL DEFAULT 0,
  due_date      TEXT,
  paid_date     TEXT,
  -- card | ach | check | cash | transfer | other
  method        TEXT,
  reference     TEXT,
  notes         TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  FOREIGN KEY (booking_id) REFERENCES bookings (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pay_booking ON booking_payments (booking_id, due_date);
CREATE INDEX IF NOT EXISTS idx_pay_user ON booking_payments (user_id, due_date);
-- The two hot queries: what is outstanding, and what came in.
CREATE INDEX IF NOT EXISTS idx_pay_outstanding ON booking_payments (user_id, paid_date, due_date);
CREATE INDEX IF NOT EXISTS idx_pay_received ON booking_payments (user_id, paid_date);
