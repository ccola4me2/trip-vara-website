-- Paying for it.
--
-- A demo already converts by changing plan from 'demo' to 'live', and nothing
-- else moves. What was missing was the money: a way for an agency to subscribe
-- without writing to anybody, and for the portal to know the next morning
-- whether the card still works.
--
-- The portal never holds a card. Stripe's hosted checkout takes it, and Stripe
-- tells the portal what happened by webhook. These columns are only what the
-- portal needs to remember about that: who the customer is, whether they are
-- paid up, and for how long.
--
-- billing_status is null for an agency that has never subscribed, which is
-- every demo and the house agency. 'active', 'past_due' and 'canceled' are the
-- only three values it takes, mapped from Stripe's longer list so nothing else
-- in this codebase has to know Stripe's vocabulary.
--
-- past_due_since starts the grace period. It is stamped by the first failed
-- payment and cleared by the next successful one, so a card that fails twice
-- in a month does not restart the clock.
--
-- product is 'full' or 'groups'. Only the first is for sale until a price for
-- the second is set.
--
-- terms_accepted_at is when the owner agreed to the terms at signup.

ALTER TABLE agencies ADD COLUMN product TEXT NOT NULL DEFAULT 'full';
ALTER TABLE agencies ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE agencies ADD COLUMN stripe_subscription_id TEXT;
ALTER TABLE agencies ADD COLUMN stripe_item_id TEXT;
ALTER TABLE agencies ADD COLUMN billing_status TEXT;
ALTER TABLE agencies ADD COLUMN past_due_since INTEGER;
ALTER TABLE agencies ADD COLUMN paid_through INTEGER;
ALTER TABLE agencies ADD COLUMN seats_billed INTEGER;
ALTER TABLE agencies ADD COLUMN terms_accepted_at INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS idx_agencies_stripe_customer
  ON agencies (stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;

-- Every webhook Stripe has sent, by its own id. Stripe delivers an event more
-- than once when it is not answered quickly, and replaying "payment failed"
-- must not move the grace clock a second time.
CREATE TABLE IF NOT EXISTS stripe_events (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
