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
| `/app/inbox` | Advisor | SMS and email threads, with a composer |
| `/app/leads` | Advisor | Contacts from GHL, add a lead |
| `/app/contact` | Advisor | One contact: details, notes, tasks, deals |
| `/app/pipeline` | Advisor | Opportunity board, drag between stages, create deals |
| `/app/calendar` | Advisor | Upcoming appointments, book new ones |
| `/app/bookings` | Advisor | Booking CRUD, deadlines, commission |
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
empty CRM. It reports presence only, never values.

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
