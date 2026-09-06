-- Pricing is per traveller, not per booking.
--
-- Two people on one cabin do not pay the same thing. One takes the drinks
-- package, one does not; a third in the same cabin pays a different fare
-- entirely. A single column of numbers for the whole reservation cannot say
-- that, so the advisor either averages it, which makes every per person figure
-- wrong, or keeps the real breakdown somewhere else, which is where it stops
-- being in the CRM at all.
--
-- NULL means the line belongs to the reservation rather than to one person:
-- a transfer booked for the cabin, a discount applied to the booking. Both
-- kinds of line total into the same trip.
ALTER TABLE booking_pricing ADD COLUMN traveller_id TEXT;

CREATE INDEX IF NOT EXISTS idx_pricing_traveller ON booking_pricing (traveller_id);
