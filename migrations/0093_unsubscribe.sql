-- The way out of an email, for every message a client reads.
--
-- This portal sent client email with no unsubscribe at all. Every message to a client
-- now carries a signed link, and the link needs two tables: the list of who has used
-- it, and a place to keep the secret the links are signed with (see unsubtoken.js).
-- Both are copied from the sister portal, where they have been in use for a while.

-- Who has asked not to be emailed.
--
-- Nothing in the portal has ever recorded this, so an automation could mail
-- somebody who had already said stop. That was survivable while every send was
-- about a booking the person actually holds, and stops being survivable the
-- day anything goes to a list.
--
-- Held per agency rather than per advisor. A client who unsubscribes is done
-- with the agency, not with the one advisor who happened to send the last
-- email, and a suppression list that a colleague can walk around is not a
-- suppression list. Not held globally either: a person on two agencies' books
-- has two relationships and can end one without ending the other.
--
-- Addresses are stored lowercased and matched exactly. Normalising further --
-- stripping dots, cutting +tags -- guesses at a provider's rules and would
-- suppress an address the person never gave anybody.

CREATE TABLE IF NOT EXISTS email_suppression (
  id          TEXT PRIMARY KEY,
  agency_id   TEXT,
  email       TEXT NOT NULL,
  -- unsubscribed | complained | bounced | manual
  reason      TEXT NOT NULL DEFAULT 'unsubscribed',
  -- Where it came from: a footer link, a Resend webhook, an advisor typing it.
  source      TEXT,
  note        TEXT,
  created_at  INTEGER NOT NULL
);

-- The question asked before every marketing send, so it has to be one lookup.
CREATE UNIQUE INDEX IF NOT EXISTS idx_suppression_who
  ON email_suppression (agency_id, email);

-- Values the portal decides for itself and must not forget.
--
-- Written for one of them: the secret that signs unsubscribe links. That key
-- has to be stable for years, because a link signed today is clicked whenever
-- somebody gets round to it, and it has to be secret, because anybody holding
-- it can mint a valid unsubscribe for any address on any agency's list.
--
-- Every candidate the Worker already had fails one of those. The Resend key and
-- the CRM token are secret and are rotated for reasons that have nothing to do
-- with email preferences. A literal in the source is stable and is published on
-- GitHub, where this repository is public.
--
-- So the portal makes its own on first use and keeps it here. Nothing to set,
-- nothing to remember, nothing in the repository. An operator who would rather
-- hold it themselves still can: UNSUBSCRIBE_SECRET in the environment wins.
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
