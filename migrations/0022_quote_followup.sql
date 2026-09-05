-- Remembering that a quote went out.
--
-- A quote sent and never followed up is the largest quiet leak in travel
-- sales, and until now the portal could not even tell you a quote had been
-- sent. The reservation looked identical the moment before and the moment
-- after. The payment chaser has recorded reminded_at from the start, for
-- exactly this reason; the client documents recorded nothing.
--
-- Counted as well as dated, because "sent once a week ago" and "sent three
-- times, still nothing" are different situations and only one of them is
-- about the quote.
ALTER TABLE bookings ADD COLUMN quote_sent_at INTEGER;
ALTER TABLE bookings ADD COLUMN quote_sent_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN statement_sent_at INTEGER;
