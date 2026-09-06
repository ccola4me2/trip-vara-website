-- The form settings a lead form actually needs beyond its questions.
--
-- Taken from the builder Brent works in today. Start and end dates matter
-- because a bridal show form should stop taking submissions when the show is
-- over, rather than being remembered about in March. The notify address
-- matters because a lead nobody is told about is a lead nobody rings, and the
-- advisor's own address is not always the right one for a stand.
--
-- source is stamped onto every submission so a lead can be traced back to the
-- event it came from, not just the form.

ALTER TABLE forms ADD COLUMN starts_on TEXT;      -- ISO day, optional
ALTER TABLE forms ADD COLUMN ends_on TEXT;        -- ISO day, optional
ALTER TABLE forms ADD COLUMN notify_email TEXT;
ALTER TABLE forms ADD COLUMN source TEXT;
