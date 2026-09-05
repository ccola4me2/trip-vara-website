-- An invoice the client can keep.
--
-- Advisors invoice clients for money the agency never touches. The fare goes
-- to the cruise line, the deposit went to the cruise line, and the client
-- still needs one document that says what the trip costs, what they have paid
-- so far and what is left. That document is the record they file, forward to
-- a spouse, and quote back at you eleven months later.
--
-- A number and an issue date are what turn a summary into that document. The
-- number is per advisor per year and assigned when the invoice is first
-- issued, not when the reservation is created: numbering a trip nobody has
-- invoiced leaves gaps in a sequence somebody may one day have to explain.
ALTER TABLE bookings ADD COLUMN invoice_no TEXT;
ALTER TABLE bookings ADD COLUMN invoice_issued_at INTEGER;
ALTER TABLE bookings ADD COLUMN invoice_notes TEXT;

-- What goes in the invoice header. An address and a registration number are
-- things a client document is expected to carry, and in several states the
-- registration is required on one. Left empty rather than guessed: inventing
-- a seller of travel number would be worse than omitting it.
ALTER TABLE users ADD COLUMN agency_address TEXT;
ALTER TABLE users ADD COLUMN seller_of_travel TEXT;
