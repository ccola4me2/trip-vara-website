-- Rate limiting for public form submissions.
--
-- The hosted form pages are unauthenticated, which is the point, so the only
-- thing between them and a script is the honeypot. That stops naive bots and
-- nothing else.
--
-- A hash of the submitter's IP is stored rather than the address itself. It is
-- enough to count repeats from one source, which is all rate limiting needs,
-- and it means a leak of this table does not hand anyone a list of who
-- submitted from where.
ALTER TABLE form_submissions ADD COLUMN ip_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_subs_ip ON form_submissions (form_id, ip_hash, created_at);
