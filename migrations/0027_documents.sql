-- The paperwork a trip generates.
--
-- Every booking produces documents: the vendor confirmation, the insurance
-- policy, air tickets, a visa letter, a copy of a passport. They live in the
-- advisor's email and their downloads folder, which means the answer to "can
-- you send me my confirmation again" is a search through both.
--
-- The file itself goes to R2. This table is the index: what it is called, what
-- kind of thing it is, which trip it belongs to and where to find it. Keeping
-- the two apart means a listing costs a database read rather than a bucket
-- listing, and the object key is never the thing a browser is given.
CREATE TABLE IF NOT EXISTS documents (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  booking_id   TEXT NOT NULL,
  object_key   TEXT NOT NULL,
  filename     TEXT NOT NULL,
  content_type TEXT,
  size_bytes   INTEGER NOT NULL DEFAULT 0,
  category     TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_documents_booking ON documents (booking_id);
