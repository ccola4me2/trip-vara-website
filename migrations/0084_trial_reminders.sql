-- Telling somebody their demo is running out, before it does.
--
-- A trial that ends in silence is a prospect who opens the portal one morning,
-- finds it shut, and concludes the product is unreliable rather than that the
-- fourteen days are up. The countdown was only ever visible on a screen they
-- do not have.
--
-- One column, holding the closest notice already sent, exactly as
-- booking_payments.auto_lead_sent does for chasing a client. Seven days out
-- gets the seven day notice and then waits for the three; the day it ends gets
-- the last one. Null means nothing has gone yet.
--
-- Kept apart from locked_at, which is about deletion rather than about
-- telling anybody. Extending a trial clears this so the notices start again,
-- and does not touch the thirty day clock, because those answer different
-- questions.

ALTER TABLE agencies ADD COLUMN trial_reminded INTEGER;
