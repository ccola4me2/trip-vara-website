-- The vendor record as a partner directory, not just a set of payment terms.
--
-- Vendors were created to stop "Carnival" and "Carnival Cruise Lines" being
-- two rows in every report, and to hold the rule for when the balance falls
-- due. What an advisor actually reaches for day to day is the other half: who
-- the business development manager is, where to register, which account number
-- the agency trades under, and which of the two hundred suppliers are the ones
-- they sell.
--
-- Favourites are a column rather than a join table because vendors are already
-- per advisor: each has their own rows, so their own star belongs on it.

ALTER TABLE vendors ADD COLUMN category TEXT;
ALTER TABLE vendors ADD COLUMN favourite INTEGER NOT NULL DEFAULT 0;
ALTER TABLE vendors ADD COLUMN bdm_name TEXT;
ALTER TABLE vendors ADD COLUMN bdm_email TEXT;
ALTER TABLE vendors ADD COLUMN bdm_phone TEXT;
ALTER TABLE vendors ADD COLUMN signup_url TEXT;
ALTER TABLE vendors ADD COLUMN website TEXT;
ALTER TABLE vendors ADD COLUMN account_number TEXT;

CREATE INDEX IF NOT EXISTS idx_vendors_category ON vendors (user_id, category, name);
