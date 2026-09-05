-- When a client was last chased about a payment.
--
-- The soft and hard model exists so somebody gets chased before a vendor
-- cancels a trip. Until now the portal could say who to chase and had no way
-- to do it, and no memory of whether it had been done. Both halves of that
-- matter: an advisor who cannot tell whether a client has already been rung
-- this week either rings twice or not at all.

ALTER TABLE booking_payments ADD COLUMN reminded_at INTEGER;
ALTER TABLE booking_payments ADD COLUMN reminder_count INTEGER NOT NULL DEFAULT 0;
