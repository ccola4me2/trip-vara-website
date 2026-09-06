-- Commission in the three parts a vendor actually pays it in.
--
-- A reservation carried one commission figure, and vendors do not pay one
-- figure. The base arrives on the vendor's normal turnaround; a package
-- override is settled with it or shortly after; the bonus for hitting a
-- target lands a quarter later, if at all. Held as one number, a reservation
-- whose base has arrived and whose bonus has not looks part-paid with no way
-- to say which part, which is the thing an advisor chases on.
--
-- Both sides get the same three kinds, so expected and received line up:
-- booking_pricing says what each part should be, commission_receipts says
-- which part the money was for. Defaulting to base keeps every figure already
-- entered meaning exactly what it meant before.

ALTER TABLE booking_pricing ADD COLUMN commission_kind TEXT NOT NULL DEFAULT 'base';
ALTER TABLE commission_receipts ADD COLUMN kind TEXT NOT NULL DEFAULT 'base';
