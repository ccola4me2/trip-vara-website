-- The rest of the vendor record, to match the directory Brent already built
-- at cruisestoursandtravel.com/vendors.
--
-- Three things that page holds and this one did not. Commission structure and
-- registration instructions are prose rather than fields: "16% on cruise fare,
-- 10% on air, bonus paid quarterly" does not reduce to a percentage, and how
-- to register with a supplier is a paragraph of instructions, not a link.
-- The single percentage stays for the arithmetic; this is what an advisor
-- actually reads before ringing.
--
-- Phone numbers are a JSON array because suppliers have several: a reservations
-- line, a groups desk, an after-hours number. One column of free text would
-- have done it, and then nothing could ever dial one.

ALTER TABLE vendors ADD COLUMN phones_json TEXT;
ALTER TABLE vendors ADD COLUMN commission_structure TEXT;
ALTER TABLE vendors ADD COLUMN registration_instructions TEXT;
