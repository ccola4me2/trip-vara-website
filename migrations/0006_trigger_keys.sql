-- Idempotent triggers.
--
-- Time based triggers are evaluated by a cron that runs every five minutes, so
-- "this payment is due in seven days" is true on every pass for a week. Without
-- a key, a single deadline would enqueue a run roughly two thousand times and
-- the client would get two thousand reminders.
--
-- trigger_key is whatever makes an event unique, typically the payment id. The
-- partial unique index makes a repeat insert fail harmlessly, so the cron can
-- stay dumb and simply try again on every pass.

ALTER TABLE automation_runs ADD COLUMN trigger_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_trigger_key
  ON automation_runs (automation_id, trigger_key)
  WHERE trigger_key IS NOT NULL;
