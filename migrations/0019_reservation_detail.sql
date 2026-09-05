-- What a reservation actually is.
--
-- Until now a reservation held a client name and a traveller count. A real one
-- is a set of named people with dates of birth and passports, in a cabin of a
-- particular category, with amenities the vendor has granted and a position on
-- insurance that matters legally.
--
-- Travellers are records rather than a number for three reasons: documents are
-- issued per person, a birthday is a reason to make contact, and a passport
-- that expires inside six months of travel is the single most common way a
-- holiday is lost at the airport.
--
-- insurance_status is deliberately not a boolean. "Declined" is a different
-- fact from "not asked", and an advisor who recorded the refusal is in a very
-- different position afterwards from one who left it blank.

ALTER TABLE bookings ADD COLUMN cabin TEXT;
ALTER TABLE bookings ADD COLUMN cabin_category TEXT;
ALTER TABLE bookings ADD COLUMN itinerary TEXT;
ALTER TABLE bookings ADD COLUMN booking_method TEXT;
ALTER TABLE bookings ADD COLUMN insurance_status TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE bookings ADD COLUMN advisor_split_pct REAL;

CREATE TABLE IF NOT EXISTS travellers (
  id              TEXT PRIMARY KEY,
  booking_id      TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  name            TEXT NOT NULL,
  dob             TEXT,
  email           TEXT,
  phone           TEXT,
  passport_number TEXT,
  passport_expiry TEXT,
  passport_country TEXT,
  is_lead         INTEGER NOT NULL DEFAULT 0,
  notes           TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_travellers_booking ON travellers (booking_id);
CREATE INDEX IF NOT EXISTS idx_travellers_dob ON travellers (user_id, dob);
CREATE INDEX IF NOT EXISTS idx_travellers_passport ON travellers (user_id, passport_expiry);

-- What the vendor has granted: onboard credit, a drinks package, a free
-- upgrade. Tracked because it is promised to a client and then forgotten, and
-- because an advisor asked for it and wants to know whether it was applied.
CREATE TABLE IF NOT EXISTS amenities (
  id           TEXT PRIMARY KEY,
  booking_id   TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  description  TEXT NOT NULL,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  source       TEXT,      -- who is paying for it: vendor, agency, client
  status       TEXT NOT NULL DEFAULT 'requested',  -- requested | confirmed | applied
  requested_on TEXT,
  notes        TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_amenities_booking ON amenities (booking_id);
