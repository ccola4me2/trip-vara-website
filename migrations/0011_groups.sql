-- Group space.
--
-- A group is a block of cabins or rooms a vendor holds for an advisor before
-- anybody has booked them. The operational fact that makes it worth modelling
-- separately from a reservation is the option date: unsold space goes back to
-- the vendor on that day, without anybody asking. It is the same shape as a
-- final payment deadline, and it is missed for the same reason, which is that
-- nothing warns you about a date nobody wrote down.
--
-- Reservations point at a group rather than groups holding a list, so a
-- reservation belongs to at most one group and moving it is one update.

CREATE TABLE IF NOT EXISTS travel_groups (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  name         TEXT NOT NULL,
  vendor       TEXT,
  product_name TEXT,
  destination  TEXT,
  group_code   TEXT,               -- the vendor's reference for the block
  depart_date  TEXT,
  return_date  TEXT,
  option_date  TEXT,               -- unsold space is released on this day
  cabins_held  INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'open',   -- 'open' | 'closed' | 'cancelled'
  notes        TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_groups_user ON travel_groups (user_id, status, depart_date);

-- Cabins sold is counted from the reservations rather than stored, so the two
-- numbers cannot disagree.
ALTER TABLE bookings ADD COLUMN group_id TEXT;
CREATE INDEX IF NOT EXISTS idx_bookings_group ON bookings (group_id);
