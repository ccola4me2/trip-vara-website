-- Annual targets, one row per advisor per year.
--
-- The basis is stored with the goal rather than assumed. "Sell £200,000 this
-- year" means one thing counted by when reservations were taken and another
-- counted by when people travel, and the two can differ by a whole quarter.
-- A target whose measurement is ambiguous is a target nobody can be held to.

CREATE TABLE IF NOT EXISTS goals (
  user_id               TEXT NOT NULL,
  year                  INTEGER NOT NULL,
  sales_goal_cents      INTEGER NOT NULL DEFAULT 0,
  commission_goal_cents INTEGER NOT NULL DEFAULT 0,
  bookings_goal         INTEGER NOT NULL DEFAULT 0,
  basis                 TEXT NOT NULL DEFAULT 'purchase',  -- 'purchase' | 'departure'
  aim                   TEXT,   -- what the year is for, in the advisor's words
  edge                  TEXT,   -- what sets them apart
  updated_at            INTEGER NOT NULL,
  PRIMARY KEY (user_id, year),
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);
