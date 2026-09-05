-- What the client pays, broken into parts, and which parts earn commission.
--
-- A reservation held one gross figure and one commission figure, both typed by
-- hand. That hides the single most important fact about travel pricing: only
-- part of what a client pays is commissionable. Cruise fare is; port taxes,
-- government fees and non-commissionable fare are not; gratuities and packages
-- are, or are not, depending on the vendor.
--
-- Without the split, "commission as a share of trips booked" on the Production
-- screen is a number that looks like an effective rate and is not one, because
-- its denominator includes money no vendor has ever paid commission on. With
-- the split, an expected commission can be worked out from the vendor's own
-- rate and compared against what actually arrived.
--
-- Deliberately one row per component rather than fifty columns. CP Maxx has a
-- column per named extra, down to spa packages and internet access, which is
-- precise and unusable: every new kind of extra is a schema change.

CREATE TABLE IF NOT EXISTS booking_pricing (
  id             TEXT PRIMARY KEY,
  booking_id     TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  kind           TEXT NOT NULL,     -- fare | taxes | ncf | gratuities | insurance | air | transfers | extra | discount
  label          TEXT,
  amount_cents   INTEGER NOT NULL DEFAULT 0,
  commissionable INTEGER NOT NULL DEFAULT 0,
  commission_cents INTEGER NOT NULL DEFAULT 0,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pricing_booking ON booking_pricing (booking_id);

-- Who paid, and with what.
--
-- Card details are deliberately absent. CP Maxx stores the card number,
-- expiry and security code against the reservation; doing the same here would
-- put this Worker and its database inside PCI scope, which is a serious
-- undertaking for a small tool and is not needed to run an agency. Recording
-- that a card was used, and its last four digits, answers every question an
-- advisor actually asks.
ALTER TABLE booking_payments ADD COLUMN paid_by TEXT;        -- traveller id
ALTER TABLE booking_payments ADD COLUMN payment_type TEXT;   -- how it was paid
ALTER TABLE booking_payments ADD COLUMN credit_id TEXT;      -- a client credit used
ALTER TABLE booking_payments ADD COLUMN card_last4 TEXT;
