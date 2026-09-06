-- The rest of what a partner directory export holds.
--
-- Brent exported the Cruise Planners partner hub and it carries far more than
-- the web page shows: how to actually place a booking with each supplier, what
-- the agency's standing with them is, and their login details. Those are the
-- things an advisor opens a vendor record to find, so they get columns rather
-- than being flattened into notes.
--
-- bdm_info keeps the manager's block as written. The name, phone and email are
-- pulled out of it for the fields above, but those entries are free text and
-- some of them are a full signature block with an address in it. Keeping the
-- original means a bad guess costs nothing.

ALTER TABLE vendors ADD COLUMN partner_status TEXT;      -- Preferred, Approved
ALTER TABLE vendors ADD COLUMN travel_types TEXT;
ALTER TABLE vendors ADD COLUMN budget_category TEXT;
ALTER TABLE vendors ADD COLUMN booking_instructions TEXT;
ALTER TABLE vendors ADD COLUMN bdm_info TEXT;
ALTER TABLE vendors ADD COLUMN vendor_login TEXT;
