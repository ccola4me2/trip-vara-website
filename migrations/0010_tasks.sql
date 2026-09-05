-- Advisor tasks.
--
-- Deliberately local rather than a mirror of the CRM's tasks. A task here is
-- the advisor's own working list, it has to be writable when the upstream API
-- is slow or unreachable, and it needs to point at a reservation, which is a
-- record the CRM does not have.
--
-- done_at rather than a done flag: knowing when something was finished is the
-- difference between a list and a record of what happened.

CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  title       TEXT NOT NULL,
  notes       TEXT,
  due_date    TEXT,                 -- ISO yyyy-mm-dd, NULL for someday
  priority    TEXT NOT NULL DEFAULT 'normal',   -- 'high' | 'normal' | 'low'
  booking_id  TEXT,                 -- optional link to a reservation
  contact_id  TEXT,                 -- optional link to a CRM contact
  done_at     INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

-- The dashboard asks "what is open, soonest first" on every load.
CREATE INDEX IF NOT EXISTS idx_tasks_open ON tasks (user_id, done_at, due_date);
CREATE INDEX IF NOT EXISTS idx_tasks_booking ON tasks (booking_id);
