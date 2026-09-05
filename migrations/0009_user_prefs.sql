-- Per user interface preferences.
--
-- Stored server side rather than in localStorage so a layout follows the
-- advisor between their laptop and their phone. It is presentation only: no
-- query reads it for anything but rendering, so a corrupt or stale row costs
-- you the default dashboard and nothing else.

CREATE TABLE IF NOT EXISTS user_prefs (
  user_id        TEXT PRIMARY KEY,
  -- JSON: { widgets: [{ id, hidden }], links: [{ label, href }] }
  dashboard_json TEXT,
  updated_at     INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);
