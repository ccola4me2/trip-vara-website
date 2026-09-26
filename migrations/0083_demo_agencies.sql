-- A fourteen day demo an agency runs with their own clients.
--
-- The hard part is not the countdown, it is that the people trying this are
-- strangers putting real client names, emails and phone numbers into somebody
-- else's portal. So a demo is never a login inside an existing agency: it is
-- its own agency, created at signup, and the fence that already separates one
-- agency's book from another's is the fence that protects them.
--
-- That matters more than it sounds. /signup with no join link drops the new
-- advisor into the first agency on the books, which is the house one. A demo
-- taking that path would file a stranger's clients in Brent's own book and
-- show them his. The demo route never calls houseAgency at all.
--
-- trial_ends_at is the whole mechanism: a second count, checked in requireUser,
-- which every handler already goes through. Null means not a trial, so every
-- agency that exists today is unaffected by construction rather than by a
-- backfill.
--
-- locked_at is stamped when a trial is first refused, and starts the thirty
-- day clock before the agency and everything in it is removed. Kept apart from
-- trial_ends_at so "expired" and "expired and told about it" stay different
-- facts, and so extending a trial does not silently restart a deletion.

ALTER TABLE agencies ADD COLUMN trial_ends_at INTEGER;
ALTER TABLE agencies ADD COLUMN locked_at INTEGER;
-- 'demo' or 'live'. A demo that converts becomes live and keeps everything.
ALTER TABLE agencies ADD COLUMN plan TEXT NOT NULL DEFAULT 'live';
-- Who asked for it, for the one question you cannot answer from a row count:
-- who is this and should I ring them.
ALTER TABLE agencies ADD COLUMN demo_email TEXT;
-- Hashed, never the address itself: enough to stop one person opening twenty
-- demos, not enough to be a list of who tried the product.
ALTER TABLE agencies ADD COLUMN demo_ip_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_agencies_trial ON agencies (plan, trial_ends_at);
