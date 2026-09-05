-- The two or three choices a real quote offers.
--
-- A quote in this portal was one trip at one price, which is not how anybody
-- sells travel. An advisor pricing an Alaska cruise sends an inside, an
-- oceanview and a balcony, and the client picks. Advisors build that in Word
-- because the systems they are given hold one number.
--
-- One row per option, on the reservation the quote belongs to. Deliberately
-- not a second reservation each: the client is choosing between cabins on one
-- trip, and three reservations would be three things to keep in step, three
-- rows in production, and two of them destined to be deleted.
--
-- `chosen` is set by the advisor when the client answers, which is also the
-- moment the reservation's price becomes real.
CREATE TABLE IF NOT EXISTS quote_options (
  id           TEXT PRIMARY KEY,
  booking_id   TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  label        TEXT NOT NULL,     -- "Balcony, deck 8"
  detail       TEXT,              -- "midship, obstructed view"
  amount_cents INTEGER NOT NULL DEFAULT 0,
  chosen       INTEGER NOT NULL DEFAULT 0,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_quote_options_booking ON quote_options (booking_id);
