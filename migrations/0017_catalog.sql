-- Local copy of the CruiseFeed sailings catalog.
--
-- Lifted from the CruiseShoppers portal, which already imports this and has
-- proved the shape over 75,000 rows. It earns its place here for three
-- reasons, in ascending order of usefulness:
--
--   A reservation can be built by picking a real sailing rather than typing a
--   vendor, a ship and a date and hoping they match what the vendor has.
--
--   Vendor and ship names arrive spelled the same way every time, which is
--   the difference between one row per vendor in a report and three.
--
--   A pasted book of business carries a departure date and no return date.
--   Matching ship and departure against this fills in the return, the nights
--   and the region, which no list an advisor can copy will ever contain.
--
-- ship_norm and line_norm are lowercased alphanumeric forms, for matching
-- names that differ only in spacing or punctuation.

CREATE TABLE IF NOT EXISTS sailings (
  id              TEXT PRIMARY KEY,   -- CruiseFeed cruise id
  cruise_line     TEXT,
  ship            TEXT,
  ship_norm       TEXT,
  line_norm       TEXT,
  name            TEXT,               -- itinerary title
  depart_date     TEXT,               -- YYYY-MM-DD
  return_date     TEXT,
  nights          INTEGER,
  departure_port  TEXT,
  disembark_port  TEXT,
  destination     TEXT,
  round_trip      INTEGER,
  price_amount    REAL,
  price_currency  TEXT,
  updated_at      INTEGER
);

CREATE INDEX IF NOT EXISTS idx_sailings_ship_norm ON sailings (ship_norm, depart_date);
CREATE INDEX IF NOT EXISTS idx_sailings_line_norm ON sailings (line_norm);
CREATE INDEX IF NOT EXISTS idx_sailings_depart ON sailings (depart_date);
CREATE INDEX IF NOT EXISTS idx_sailings_cruise_line ON sailings (cruise_line, depart_date);
CREATE INDEX IF NOT EXISTS idx_sailings_line_ship ON sailings (line_norm, ship);

-- Import progress: the paging cursor, the snapshot date last imported, row
-- counts and last-run timestamps.
CREATE TABLE IF NOT EXISTS catalog_import_state (
  k TEXT PRIMARY KEY,
  v TEXT
);
