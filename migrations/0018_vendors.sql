-- Vendors as records, and the terms they trade on.
--
-- A reservation carries the vendor as free text, so "Carnival", "Carnival
-- Cruise Line" and "Carnival Cruise Lines" are three vendors to every report
-- that groups by it. Commission owed by vendor, production by vendor and the
-- oldest outstanding item per vendor all split across spellings, and an
-- imported book makes it worse rather than better.
--
-- The other half of this is terms. Every vendor has a rule for when the
-- balance falls due, usually a fixed number of days before departure. Holding
-- that here means a reservation with no final payment date can be given the
-- right one instead of being left to chance.

CREATE TABLE IF NOT EXISTS vendors (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  name          TEXT NOT NULL,
  final_days    INTEGER,          -- days before departure the balance is due
  deposit_days  INTEGER,          -- days after booking the deposit is due
  commission_pct REAL,            -- the rate usually paid, for a sanity check
  phone         TEXT,
  email         TEXT,
  portal_url    TEXT,
  notes         TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_vendors_name ON vendors (user_id, name);

ALTER TABLE bookings ADD COLUMN vendor_id TEXT;
CREATE INDEX IF NOT EXISTS idx_bookings_vendor ON bookings (vendor_id);

INSERT OR IGNORE INTO vendors (id, user_id, name, created_at, updated_at)
SELECT lower(hex(randomblob(16))), user_id, supplier,
       strftime('%s','now'), strftime('%s','now')
  FROM (SELECT DISTINCT user_id, supplier FROM bookings
         WHERE supplier IS NOT NULL AND TRIM(supplier) != '');

UPDATE bookings SET vendor_id = (
  SELECT v.id FROM vendors v
   WHERE v.user_id = bookings.user_id AND v.name = bookings.supplier
) WHERE vendor_id IS NULL;
