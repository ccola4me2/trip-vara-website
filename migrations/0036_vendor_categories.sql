-- A supplier sits on more than one shelf.
--
-- Thirty-five of the two hundred and eight in the partner export are listed
-- under several categories: Celebrity Cruises sells ocean cruises and
-- expeditions, Classic Vacations does packages, independent travel and villas.
-- The import kept the first and dropped the rest, so those suppliers went
-- missing from every category but one, which is exactly where somebody would
-- look for them.
--
-- category stays as the primary one, because reports group by it and the edit
-- form offers a single choice. categories_json is the full list, and the
-- directory lists a vendor under each entry in it. Same record either way: the
-- suppliers are not duplicated, they are shelved more than once.

ALTER TABLE vendors ADD COLUMN categories_json TEXT;
