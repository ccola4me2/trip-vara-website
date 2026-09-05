-- Soft and hard payment dates.
--
-- Modelled on how the trade actually works, and on how CP Maxx presents it:
-- payments are split into Soft, Hard and Past Due rather than deposit,
-- instalment and final.
--
--   A hard payment is the vendor's real deadline. Miss it and the reservation
--   is cancelled. It is not a debt that can be chased afterwards.
--
--   A soft payment is the advisor's own earlier reminder, giving a buffer to
--   collect from the client before the vendor's date arrives.
--
-- The old kind column stays: deposit, instalment and final are still what a
-- payment IS. This adds what it MEANS, which is a separate question and the
-- one that decides whether a reservation survives.
ALTER TABLE booking_payments ADD COLUMN payment_class TEXT NOT NULL DEFAULT 'hard';

CREATE INDEX IF NOT EXISTS idx_pay_class
  ON booking_payments (user_id, payment_class, paid_date, due_date);

-- Everything already recorded is a vendor deadline: nothing so far was
-- entered as an internal reminder, so defaulting to hard is accurate rather
-- than merely convenient.
UPDATE booking_payments SET payment_class = 'hard' WHERE payment_class IS NULL;
