-- Somebody writing in through Get in touch.
--
-- A row rather than only an email, for three reasons.
--
-- It is the rate limit. Every other public form here counts its own earlier
-- rows by a hashed address, and support had nowhere to count. The first
-- version borrowed activity_log, which has a NOT NULL user_id and a foreign
-- key to users, and a stranger has neither.
--
-- It is the record. The message is the one thing on that page that exists
-- nowhere else: lose the email and you lose somebody's question and never know
-- it happened.
--
-- And it puts the send the right way round. Everything else in this portal
-- writes the row and then tries to tell somebody, so a mail service having a
-- bad morning costs a notice rather than the thing itself.
--
-- user_id is nullable on purpose. The person most likely to be here is a demo
-- whose trial has ended, and they cannot sign in at all.
CREATE TABLE IF NOT EXISTS support_messages (
  id          TEXT PRIMARY KEY,
  user_id     TEXT,
  name        TEXT,
  email       TEXT NOT NULL,
  agency_name TEXT,
  subject     TEXT,
  message     TEXT NOT NULL,
  ip_hash     TEXT,
  -- Whether the email to whoever runs the portal actually went.
  sent        INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_support_ip ON support_messages (ip_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_support_created ON support_messages (created_at);
