-- Clients as records rather than as a name typed onto a reservation.
--
-- Reservations have always carried client_name, and everything that needed a
-- client grouped by that string. It works until two people share a name, and
-- it leaves nowhere to put an email address or a phone number, so the portal
-- could tell you a client was worth ringing without being able to ring them.
--
-- The backfill below creates one client per distinct name an advisor has used
-- and points their reservations at it. Two genuinely different people who
-- share a name are merged by this, exactly as they were before: the migration
-- does not make that worse, it just gives us a record to separate them on
-- later.

CREATE TABLE IF NOT EXISTS clients (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  name           TEXT NOT NULL,
  email          TEXT,
  phone          TEXT,
  notes          TEXT,
  ghl_contact_id TEXT,
  pinned_at      INTEGER,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_name ON clients (user_id, name);
CREATE INDEX IF NOT EXISTS idx_clients_pinned ON clients (user_id, pinned_at);

ALTER TABLE bookings ADD COLUMN client_id TEXT;
CREATE INDEX IF NOT EXISTS idx_bookings_client ON bookings (client_id);

ALTER TABLE client_credits ADD COLUMN client_id TEXT;
CREATE INDEX IF NOT EXISTS idx_credits_client ON client_credits (client_id);

-- Backfill. randomblob(16) rather than a sequence so the ids look like every
-- other id in this database.
--
-- From reservations and from credits both: a client can hold a future cruise
-- credit without ever having booked through this portal, and seeding only
-- from reservations left those credits pointing at nobody.
INSERT OR IGNORE INTO clients (id, user_id, name, created_at, updated_at)
SELECT lower(hex(randomblob(16))), user_id, client_name,
       strftime('%s','now'), strftime('%s','now')
  FROM (SELECT DISTINCT user_id, client_name FROM bookings
         WHERE client_name IS NOT NULL AND TRIM(client_name) != '');

INSERT OR IGNORE INTO clients (id, user_id, name, created_at, updated_at)
SELECT lower(hex(randomblob(16))), user_id, client_name,
       strftime('%s','now'), strftime('%s','now')
  FROM (SELECT DISTINCT user_id, client_name FROM client_credits
         WHERE client_name IS NOT NULL AND TRIM(client_name) != '');

UPDATE bookings SET client_id = (
  SELECT c.id FROM clients c
   WHERE c.user_id = bookings.user_id AND c.name = bookings.client_name
) WHERE client_id IS NULL;

UPDATE client_credits SET client_id = (
  SELECT c.id FROM clients c
   WHERE c.user_id = client_credits.user_id AND c.name = client_credits.client_name
) WHERE client_id IS NULL;
