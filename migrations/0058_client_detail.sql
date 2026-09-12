-- Everything a vendor asks for about a person, on the person.
--
-- A client record held a name, an email, a phone and a birthday, which is
-- enough to ring somebody and not enough to book them on anything. The legal
-- name, the passport and the address were typed onto each reservation
-- instead, so the same passport number was entered once a trip and was wrong
-- somewhere in the middle.
--
-- Ported from the CTT fork, which added these as 0058 and 0059. Combined here
-- because neither has been applied to this database and two migrations to add
-- twenty columns is two chances to apply one and not the other.

ALTER TABLE clients ADD COLUMN legal_first TEXT;
ALTER TABLE clients ADD COLUMN legal_middle TEXT;
ALTER TABLE clients ADD COLUMN legal_last TEXT;
ALTER TABLE clients ADD COLUMN gender TEXT;
ALTER TABLE clients ADD COLUMN citizenship TEXT;
ALTER TABLE clients ADD COLUMN passport_number TEXT;
ALTER TABLE clients ADD COLUMN passport_country TEXT;
ALTER TABLE clients ADD COLUMN passport_issued TEXT;
ALTER TABLE clients ADD COLUMN passport_expiry TEXT;
ALTER TABLE clients ADD COLUMN address1 TEXT;
ALTER TABLE clients ADD COLUMN address2 TEXT;
ALTER TABLE clients ADD COLUMN city TEXT;
ALTER TABLE clients ADD COLUMN state TEXT;
ALTER TABLE clients ADD COLUMN postcode TEXT;
ALTER TABLE clients ADD COLUMN country TEXT;
ALTER TABLE clients ADD COLUMN loyalty_json TEXT;
ALTER TABLE clients ADD COLUMN known_traveler TEXT;
ALTER TABLE clients ADD COLUMN redress TEXT;

-- What the client is actually called, as against what is on the passport.
-- "Barbara" is on the document and "Barb" is what she answers to, and an
-- advisor greeting somebody by their legal name sounds like a cold call.
ALTER TABLE clients ADD COLUMN nickname TEXT;

-- Where they came from: a referral, Facebook, a repeat booking. The only
-- field in the whole record that answers which marketing is working.
ALTER TABLE clients ADD COLUMN source TEXT;

-- Asked as "who came from Facebook" rather than by walking every client.
CREATE INDEX IF NOT EXISTS idx_clients_source ON clients (user_id, source);
