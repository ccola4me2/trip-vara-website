# Trip Vara Advisor Portal

An authenticated CRM portal for travel advisors, at **tripvaratravel.com**.

GoHighLevel stays the system of record for contacts, opportunities, notes and
calendars. The portal is a travel-shaped interface on top of it, plus the one
thing GHL cannot model cleanly: bookings with suppliers, confirmation numbers,
sail dates, payment deadlines and commission.

Cloudflare Worker + static assets + D1, no build step, deployed from GitHub
`main` via Cloudflare Workers Builds. Same shape as the cruiseshoppers repo.

---

## What is in it

| Area | Source of truth | Notes |
| --- | --- | --- |
| Leads and contacts | GoHighLevel | Live read and write, with a full record page |
| Conversations | GoHighLevel | SMS and email threads, send and reply from the portal |
| Pipeline and opportunities | GoHighLevel | Board grouped by the pipeline's own stages, drag to move |
| Calendar and appointments | GoHighLevel | Agenda across all active calendars, booking included |
| Bookings and trips | D1 | Supplier, confirmation, dates, payments, commission |
| Invoices and payments | GoHighLevel | Reconciled against what bookings expect |
| Dashboard and reports | Both | Booking numbers from D1, live pipeline value from GHL |
| Advisor accounts | D1 | Email and password, admin approves before access |

If GoHighLevel is not connected, the leads and pipeline pages say so plainly and
the rest of the portal keeps working. That is deliberate: booking and commission
tracking has value on its own.

## Pages

| Path | Who | What |
| --- | --- | --- |
| `/` | Public | Sign-in landing |
| `/login`, `/signup` | Public | Sign in, request access |
| `/forgot-password`, `/reset-password` | Public | Password reset |
| `/pending` | Public | Shown while an account awaits approval |
| `/app/` | Advisor | Dashboard: numbers, payments due, activity |
| `/app/inbox` | Advisor | Messages: SMS and email threads, with a composer |
| `/app/leads` | Advisor | Clients: everyone in the book of business |
| `/app/contact` | Advisor | One contact: details, notes, tasks, deals |
| `/app/pipeline` | Advisor | Sales opportunities: board, drag between stages, create deals |
| `/app/calendar` | Advisor | Upcoming appointments, book new ones |
| `/app/tasks` | Advisor | The advisor's own working list |
| `/app/reservations` | Advisor | Reservation CRUD, vendor deadlines, commission |
| `/app/billing` | Advisor | Invoices, transactions, reconciliation against reservations |
| `/app/reports` | Advisor | Production by departure month |
| `/app/settings` | Advisor | Profile, password, CRM binding |
| `/admin/` | Admin | Approve, suspend and bind advisors |

---

## Local development

Requires Node 18+ only for Wrangler. Nothing is compiled.

```bash
npm install
npx wrangler d1 migrations apply trip-vara --local
npx wrangler dev --local
```

Then open http://127.0.0.1:8787.

### Creating the first admin

Signup always creates a `pending` advisor, so the first admin has to be promoted
by hand. Sign up through the UI, then:

```bash
npx wrangler d1 execute trip-vara --local --command "UPDATE users SET role='admin', status='active' WHERE email='you@example.com';"
```

Drop `--local` and use `--remote` to do the same against production. After that,
every other account is approved from `/admin/`.

---

## Checking page contracts

This is plain JavaScript with no build step, so nothing catches a page reading
a field the API stopped returning. That is not hypothetical: a rename moved
`collectedCents` to `postedCents`, the follow-up edit to the page silently
failed to apply, and two figures on Payments rendered as zero. Nothing threw.

```bash
npx wrangler dev --local          # in one terminal
npm run check:contracts           # in another
```

It signs in, fetches the endpoint behind each page, and compares every field
the page reads against what actually came back. A page whose response has no
rows is reported as unverifiable rather than passed or failed, because an empty
table and a misspelled field look identical and guessing is what makes a
checker not worth running. The same applies within a response: if one
collection came back empty, a field missing from it is reported as
unverifiable, and the empty collection is named.

### Smoke test

```bash
npx wrangler dev --local          # in one terminal
npm run check:smoke               # in another
```

The contract checker asks whether a page reads fields the API returns. It says
nothing about whether a sequence of requests does the right thing, and three of
this portal's paths were only ever exercised by a real person doing a real
thing weeks apart:

- signup, pending, admin approval, first sign in
- a hosted form submission arriving as a lead
- an automation firing from that submission and running

The smoke test drives all three end to end against a local dev server in under
a second, plus a reservation and the soft/hard schedule built from it. It
cleans up after itself, including when it bails early.

## The dashboard

Panels can be reordered and switched off per advisor, and the arrangement is
stored server side so it follows them between a laptop and a phone. Reordering
works by drag and by arrow buttons: drag alone would leave the dashboard
unarrangeable for anyone not using a mouse.

The panel catalogue lives in `src/prefs.js`, on the server, because a saved
layout is user supplied data that gets rendered back into a page. Unknown ids
are dropped rather than stored, duplicates collapse, and panels added in a
later release are appended to everyone's layout on read, so a new panel
appears without anybody having to reset their dashboard.

Quick links accept `http` and `https` only. A saved `javascript:` URL would be
stored once and then clicked by its author on every later visit.

## Who sees what

Two kinds of account use the portal.

**An agency owner is an admin.** They see every advisor's reservations,
payments and production, and every screen that can span more than one advisor
carries a picker to narrow it down. Reports break down per advisor. An
independent advisor working alone is also an admin, where "everyone" happens to
be just them, so one code path covers both without a setting to get wrong.

**An advisor associate sees their own records and nothing else.** No picker is
offered, and `?advisor=` in the query string is ignored for them: the scope is
derived from the signed in user, never from the request.

Seeing is not editing. An owner can open an associate's reservation but cannot
write to it. Reads use the visibility scope; every write uses `selfScope`, and
keeping those two lookups separate is what stops them quietly becoming one
permission. The smoke test asserts each of these from both sides.

## Deploying

No Node or CLI required. Everything below is done in the Cloudflare dashboard,
the same way the other Worker sites are run.

1. **Create the database.** Storage & Databases > D1 > Create database, named
   `trip-vara`. Its id is already in `wrangler.toml`.
2. **Create the tables.** Open the database, go to the **Console** tab, paste
   the whole of `migrations/0001_init.sql`, and run it. Every later migration in
   that folder is applied the same way, in filename order.
3. **Connect the Worker.** Workers & Pages > Create > Import a repository, and
   pick this repo. Workers Builds reads `wrangler.toml` and wires up the D1
   binding and static assets automatically. Pushes to `main` redeploy.
4. **Add the secrets** under the Worker's Settings > Variables and Secrets. See
   the table below.
5. **Make the first admin.** Visit `/signup` on the deployed URL and sign up.
   That creates a `pending` account which cannot sign in. Then run this in the
   D1 Console tab:

   ```sql
   UPDATE users SET role='admin', status='active' WHERE email='you@example.com';
   ```

   Every account after that is approved from `/admin/` with a button.
6. **Point the domain** at the Worker under Settings > Domains & Routes.

If you do have Node locally, the same steps are available as
`npx wrangler d1 create trip-vara`, `npx wrangler d1 migrations apply trip-vara --remote`,
and `npx wrangler secret put GHL_API_TOKEN`.

### A secret set in the dashboard needs a deploy

This Worker is deployed by Workers Builds from git, so adding or changing a
secret in the dashboard does **not** reach the running Worker on its own. The
Variables and Secrets page has no Deploy button, because deployment comes from
`main`. Push any commit, or hit Retry build on the latest deployment, and the
new secret takes effect with it.

`GET /api/admin/health` lists every binding and variable the Worker can
actually see, which is the quickest way to tell "not deployed yet" apart from
"saved in the wrong place".

### Secrets

| Secret | Required | Purpose |
| --- | --- | --- |
| `GHL_API_TOKEN` | For everything CRM | GoHighLevel Private Integration Token. Create it at Settings > Private Integrations on the Trip Vara sub-account, with contacts read/write, opportunities read/write and calendars read. Without it those two pages show a setup notice; everything else works. |
| `RESEND_API_KEY` | For email | Approval, welcome and password-reset emails. Without it sends are skipped and logged, and nothing fails. |

Non-secret config lives in `[vars]` in `wrangler.toml`, including
`GHL_DEFAULT_LOCATION_ID`, currently the Trip Vara sub-account
`4Hb35fhCOJSuOmKDA1bY`.

---

## GoHighLevel tenancy

Every advisor resolves to a location id: their own `ghl_location_id` in D1 when
set, otherwise `GHL_DEFAULT_LOCATION_ID`. That supports both models without a
code change.

- **One shared sub-account.** Leave `ghl_location_id` null on every advisor.
  Everyone works in the Trip Vara sub-account. Set each advisor's `ghl_user_id`
  from `/admin/` so records can be attributed to them.
- **A sub-account per advisor.** Bind each advisor to their own location id from
  `/admin/`. This needs an agency-level token that can reach all of them.

`src/ghl.js` is the only file that talks to GoHighLevel, and it normalizes every
response, so the rest of the portal never depends on GHL's field naming. It also
retries rate limits and 5xx with backoff, because a single transient failure was
otherwise surfacing to advisors as a scope problem.

### Checking the token

`GET /api/admin/health?probe=1` (admin only) pings one cheap read per GHL area
and reports which the token can reach. A Private Integration Token has a fixed
scope set chosen at creation, and a missing scope returns 403 rather than an
empty result, so this is the fastest way to tell a permissions problem from an
empty CRM. It reports presence only, never values. `?probe=email` asks Resend whether the
key is accepted and the sending domain verified, and `POST /api/admin/test-email`
sends for real and returns Resend's actual response.

### Email deliverability

Sending needs more than a verified domain. Yahoo and Gmail both require a DMARC
record, and a domain with SPF and DKIM but no DMARC gets silently dropped rather
than bounced, which looks identical to a broken app. `_dmarc.tripvaratravel.com`
carries `v=DMARC1; p=none; rua=...`. If mail stops arriving, check that record
before suspecting the portal.

The portal needs contacts, opportunities, conversations, conversation messages,
calendars, custom fields, tags and users.

---

## Layout

```
src/
  worker.js     Router, auth gate on /app and /admin, static asset serving
  auth.js       Signup, sign in, sessions, password reset, requireUser/requireAdmin
  db.js         Every D1 query
  ghl.js        GoHighLevel client and response normalizers
  leads.js      Contacts, notes, tasks, the full record
  conversations.js  Threads, messages, sending
  calendar.js   Calendars and appointments
  billing.js    Invoices, transactions, reconciliation
  pipeline.js   Pipelines and opportunities
  bookings.js   Booking CRUD and validation
  reports.js    Dashboard and production numbers
  admin.js      Approve, suspend, bind advisors
  email.js      Resend templates
  util.js       JSON responses, cookies, PBKDF2, validation
public/
  css/app.css   Whole design system, hand written
  js/app.js     API wrapper, formatting, app shell
  app/          Advisor pages
  admin/        Admin pages
migrations/     D1 schema
```

## Security notes

- Passwords are PBKDF2-SHA256, 100k iterations, per-user salt.
- The session cookie holds a random token; D1 stores only its SHA-256, so a
  database read cannot mint a session.
- Cookies are `HttpOnly`, `Secure`, `SameSite=Lax`.
- Signup never reveals whether an address is already registered, and password
  reset always answers the same way.
- Changing a password or suspending an account deletes that user's sessions
  immediately rather than waiting for expiry.
- `run_worker_first = true` is what makes the page gate real. Without it
  Cloudflare would serve `/app/*.html` directly and skip the session check.

## Brand

Navy `#1b3a5f` with a coral `#f1705b` accent, from the Trip Vara logo. Tokens
are at the top of `public/css/app.css`. `public/logo-mark.svg` is a vector
rebuild of the supplied mark; replace it with the original artwork if you have
the source file.

## History

The `marketing-site` branch holds an earlier public marketing site for the same
brand (Next.js on Vercel). It is kept for reference and is not deployed.
