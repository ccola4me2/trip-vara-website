-- What kind of group it is, and letting people put their name down for it.
--
-- Taken from the group form Brent works in, which asks for a type and offers
-- online registrations. The type matters because a cruise group, a package
-- and a block of rooms are held and sold differently, and a list that cannot
-- tell them apart makes the advisor remember which is which.
--
-- Registration is the larger half. A group trip is sold by telling people
-- about it and collecting names, and that was happening in email: the advisor
-- posts about a sailing, replies arrive in an inbox, and the list of who is
-- interested lives in their head. A group can now have a page of its own that
-- takes names, and each one arrives attached to the group rather than as a
-- loose lead nobody can place.

ALTER TABLE travel_groups ADD COLUMN group_type TEXT NOT NULL DEFAULT 'cruise';
ALTER TABLE travel_groups ADD COLUMN registration_open INTEGER NOT NULL DEFAULT 0;
ALTER TABLE travel_groups ADD COLUMN registration_blurb TEXT;

CREATE TABLE IF NOT EXISTS group_registrations (
  id           TEXT PRIMARY KEY,
  group_id     TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  name         TEXT NOT NULL,
  email        TEXT,
  phone        TEXT,
  party_size   INTEGER,
  notes        TEXT,
  -- Set when the advisor turns the interest into a real reservation, so a
  -- name that has been acted on stops looking like one that has not.
  booking_id   TEXT,
  contact_id   TEXT,
  ip_hash      TEXT,
  created_at   INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  FOREIGN KEY (group_id) REFERENCES travel_groups (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_group_reg ON group_registrations (group_id, created_at);
CREATE INDEX IF NOT EXISTS idx_group_reg_user ON group_registrations (user_id, created_at);
