# What this portal keeps, where the copies are, and how to get rid of it

Written for whoever runs Trip Vara, and for an agency owner who asks the
question. Short on purpose. If something here stops being true, change it here
rather than in somebody's memory.

## The only copy problem

Most of what an agency types in exists nowhere else. The vendor has their own
record of their own booking. Nobody has the book: the client list, what each
reservation is really made of, what has been paid, who is travelling, what is
owed and by when. That is the thing worth backing up, and it is the reason an
export is a feature rather than a nicety.

## Three copies, doing different jobs

**D1 Time Travel.** Cloudflare keeps a restorable history of the database for
the last 30 days. This is the right tool for "a migration went wrong on
Tuesday" or "something deleted a table". It restores the whole database, every
agency at once, so it is never the answer to one agency's problem. Only the
portal operator can reach it, from the Cloudflare dashboard.

**The weekly bundle.** Every Sunday, early, the Worker writes one JSON file per
agency into the private R2 bucket under `backups/<agency id>/<date>.json`. The
last eight are kept and older ones are removed. Demo agencies are skipped: they
are swept after 30 days anyway, and backing up a fortnight's trial data is
noise. An agency with no active owner is skipped and named in the result, since
there is no correct scope to run it under.

Run it by hand with `POST /api/admin/backup`, which is on the admin page and is
the portal operator's button, not an owner's. It is safe to run twice: a bundle
already written for that day is left alone.

**The owner's own export.** `Settings > Take your records with you`, or
`GET /api/export`. Scoped exactly like every screen: an owner gets the agency,
an advisor gets themselves. This is the copy to hand somebody who is leaving,
and the one an agency should take occasionally on their own account.

Document bytes are not in any bundle. The index is, with the filename, size,
category and the R2 key, so a restore knows what is missing.

## Retention

| | |
|---|---|
| Live records | Kept while the agency is on the portal |
| Demo agencies | Locked 14 days after signup, deleted 30 days after the lock |
| Weekly bundles | The last 8 per agency |
| Time Travel | 30 days, Cloudflare's own window |
| Sessions | `SESSION_TTL_DAYS`, 30 by default, purged on the cron |
| Password reset tokens | `RESET_TTL_MINUTES`, 60 by default |
| Automation run history | Purged on the cron |

## Deleting an agency

`DELETE /api/agencies/:id`, platform owner only. D1 does not enforce foreign
keys, so nothing cascades: the delete names every table that carries a row for
those people, and the list is derived from the generated schema so a new table
is covered without anybody remembering. See `userOwnedTables()` in
`src/demo.js`.

After the delete, the agency's weekly bundles are still in R2. Remove them
too when the request is "delete my data", rather than only when it is "close my
account":

    backups/<agency id>/

## Sample data

`npm run seed:sample > sample.sql` prints a worked example: one agency, an
owner and an advisor, four clients, a household, a lead, a group with three
rate bands and three sign-ups, two reservations priced by their parts, and a
payment schedule with a line already past due. Apply it with

    ./node_modules/.bin/wrangler d1 execute trip-vara --local --file sample.sql

Nothing in it hides what it is. The agency is `Sample Travel Co`, every person
is named Sample, and the ids all begin `sample-`. Dates are relative to the day
it is generated, so the example keeps making sense months later. Never run it
against production.

## The lists a group sends out

Four, from the group's own screen: a supplier manifest, a rooming list, a
flight list and a dining list. All CSV, because the other end is always a
spreadsheet and a cruise line's group desk will take a CSV from anybody.

**The manifest is the only one carrying a passport number in full**, and taking
one is written to the activity log with the group and how many people were on
it. The other three decrypt nothing.

Every field is escaped against spreadsheet formula injection: a value starting
`=`, `+`, `-` or `@` is prefixed with an apostrophe. These files go to other
companies, so that is not optional.

## Personal detail an agency holds

Clients and travellers carry names, dates of birth, passport numbers and
expiry dates, emergency contacts, and dietary or accessibility needs. All of it
is there because a supplier asks for it to make a booking.

Group travellers, the records created by somebody registering for a group trip
on a public page, hold their date of birth and passport details **encrypted**.
See `docs/encryption.md`. The older per-reservation `travellers` records and the
passport fields on `clients` are not encrypted: they predate this and
re-encrypting them changes live data, which is a decision for the agency rather
than a change to slip in.

Nothing in this portal stores a card number, and nothing in it takes a payment.
The client pays the travel supplier, or pays the agency outside the portal
through the link the agency sets in `Agency > Payment instructions`. The portal
records what was paid and chases what is due.
