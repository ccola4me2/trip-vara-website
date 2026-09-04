-- Own the CRM data.
--
-- Until now GoHighLevel was the system of record and every read hit their API.
-- These tables make D1 the source of truth for contacts, pipelines and
-- opportunities, kept current by a resumable background sync. Reads come from
-- here, so the portal stays fast and keeps working when the upstream API is
-- slow, rate limiting, or down.
--
-- Writes still go upstream first and are then mirrored here, so the two never
-- silently diverge. Conversations are deliberately NOT mirrored: messages are
-- delivered by the upstream platform and mirroring them would create a second,
-- always-stale copy of a live inbox.

-- Ids are the upstream ids, so a record can always be traced back and a resync
-- updates in place rather than duplicating.
CREATE TABLE IF NOT EXISTS crm_contacts (
  id            TEXT PRIMARY KEY,
  location_id   TEXT NOT NULL,
  first_name    TEXT,
  last_name     TEXT,
  name          TEXT,
  email         TEXT,
  phone         TEXT,
  source        TEXT,
  tags_json     TEXT,
  city          TEXT,
  state         TEXT,
  country       TEXT,
  assigned_to   TEXT,
  created_at    TEXT,
  updated_at    TEXT,
  synced_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_crm_contacts_loc ON crm_contacts (location_id);
CREATE INDEX IF NOT EXISTS idx_crm_contacts_email ON crm_contacts (location_id, email);
CREATE INDEX IF NOT EXISTS idx_crm_contacts_phone ON crm_contacts (location_id, phone);
CREATE INDEX IF NOT EXISTS idx_crm_contacts_created ON crm_contacts (location_id, created_at);
CREATE INDEX IF NOT EXISTS idx_crm_contacts_name ON crm_contacts (location_id, name);

CREATE TABLE IF NOT EXISTS crm_pipelines (
  id          TEXT PRIMARY KEY,
  location_id TEXT NOT NULL,
  name        TEXT,
  stages_json TEXT,
  synced_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_crm_pipelines_loc ON crm_pipelines (location_id);

CREATE TABLE IF NOT EXISTS crm_opportunities (
  id             TEXT PRIMARY KEY,
  location_id    TEXT NOT NULL,
  pipeline_id    TEXT,
  stage_id       TEXT,
  name           TEXT,
  status         TEXT,
  monetary_value REAL NOT NULL DEFAULT 0,
  contact_id     TEXT,
  contact_name   TEXT,
  contact_email  TEXT,
  contact_phone  TEXT,
  assigned_to    TEXT,
  source         TEXT,
  created_at     TEXT,
  updated_at     TEXT,
  synced_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_crm_opps_loc ON crm_opportunities (location_id);
CREATE INDEX IF NOT EXISTS idx_crm_opps_pipeline ON crm_opportunities (location_id, pipeline_id);
CREATE INDEX IF NOT EXISTS idx_crm_opps_contact ON crm_opportunities (contact_id);

-- One row per sync job. Holds the cursor so a run can pick up where the last
-- one stopped, which is what keeps a large backfill inside a Worker's limits.
CREATE TABLE IF NOT EXISTS sync_state (
  id           TEXT PRIMARY KEY,      -- e.g. contacts:<locationId>
  kind         TEXT NOT NULL,
  location_id  TEXT NOT NULL,
  cursor       TEXT,
  status       TEXT NOT NULL DEFAULT 'idle',  -- idle | running | complete | error
  detail       TEXT,
  records      INTEGER NOT NULL DEFAULT 0,
  started_at   INTEGER,
  finished_at  INTEGER,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sync_kind ON sync_state (kind, location_id);
