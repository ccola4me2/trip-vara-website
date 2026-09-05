-- What the client loses if they cancel.
--
-- One of the two or three questions a client actually asks, and the portal had
-- no answer at all. The advisor reads it off a vendor's confirmation, works it
-- out in their head against today's date, and hopes.
--
-- Tiers can hang off a vendor, as their standard terms, or off one
-- reservation, as the terms that trip was actually sold on. Exactly one of the
-- two is set on any row.
--
-- Deliberately copied onto a reservation rather than followed live from the
-- vendor, which is the opposite of how the commission split works. A split is
-- an agreement between an agency and an advisor and changing it should change
-- every trip that has not been given its own figure. A cancellation penalty is
-- a term of a contract the client already signed: it was fixed the day they
-- booked, and a vendor changing their standard terms next year must not
-- silently rewrite what this client agreed to.
--
-- from_days is the number of days before departure at which the tier starts to
-- apply, and it applies until a tier with a smaller from_days takes over. A
-- percentage is of the trip total; an amount is that amount. One or the other,
-- never both, because "50% or $500" is not a term anybody wrote.
CREATE TABLE IF NOT EXISTS penalty_tiers (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  vendor_id    TEXT,
  booking_id   TEXT,
  from_days    INTEGER NOT NULL,
  pct          REAL,
  amount_cents INTEGER,
  note         TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_penalty_vendor ON penalty_tiers (vendor_id);
CREATE INDEX IF NOT EXISTS idx_penalty_booking ON penalty_tiers (booking_id);
