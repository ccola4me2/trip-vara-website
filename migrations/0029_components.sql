-- One trip, several vendors.
--
-- A cruise with air on it is two bookings with two vendors, two confirmation
-- numbers and two commission cheques, and it is one holiday. Until now the
-- reservation held exactly one vendor, so the air went in as a second
-- reservation that duplicated the client, the dates and the trip, or it went
-- in nowhere and the commission on it was never chased.
--
-- Deliberately no money on this table. A component is who you booked with and
-- what they gave you: a vendor, a confirmation number, its own dates. What it
-- costs lives where all the other money lives, as pricing lines tagged with
-- the component they belong to. One money model, so the trip total, the
-- commission, the invoice and every report keep working without knowing
-- components exist.
CREATE TABLE IF NOT EXISTS components (
  id                  TEXT PRIMARY KEY,
  booking_id          TEXT NOT NULL,
  user_id             TEXT NOT NULL,
  kind                TEXT NOT NULL,   -- air | insurance | lodging | excursion | transfer | other
  vendor_id           TEXT,
  supplier            TEXT,
  product_name        TEXT,
  confirmation_number TEXT,
  start_date          TEXT,
  end_date            TEXT,
  notes               TEXT,
  sort_order          INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_components_booking ON components (booking_id);

-- Which component a charge belongs to. NULL is the reservation's own vendor,
-- which is every line written before today and most lines written after it.
ALTER TABLE booking_pricing ADD COLUMN component_id TEXT;
