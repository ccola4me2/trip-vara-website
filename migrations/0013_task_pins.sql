-- Pinned tasks.
--
-- A pin is not a priority. Priority says how important a task is; a pin says
-- this is the one I am working on now, which is a different thing and changes
-- several times a day. Storing when it was pinned rather than a flag keeps
-- the pinned list in the order they were pinned.

ALTER TABLE tasks ADD COLUMN pinned_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_tasks_pinned ON tasks (user_id, pinned_at);
