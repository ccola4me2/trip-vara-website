-- Does an advisor's own travel count towards their target?
--
-- Asked, and the answer was that it can but not always. Booking your own
-- holiday through the agency earns real commission and is real production; it
-- is also not the client selling an annual target is usually about. Neither
-- answer is right for every year, so the target carries the choice rather than
-- the code assuming one.
--
-- Defaults to 0: a target is about clients unless somebody says otherwise, and
-- a figure that quietly includes your own holidays is the one that would be
-- found out later.

ALTER TABLE goals ADD COLUMN count_personal INTEGER NOT NULL DEFAULT 0;
