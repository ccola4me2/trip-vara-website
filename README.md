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
| Leads and contacts | GoHighLevel | Live read and write, with notes |
| Pipeline and opportunities | GoHighLevel | Board grouped by the pipeline's own stages |
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
| `/app/leads` | Advisor | Contacts from GHL, add a lead |
| `/app/pipeline` | Advisor | Opportunity board by stage |
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

1. Create the database once and paste the returned id into `wrangler.toml`:
   ```bash
   npx wrangler d1 create trip-vara
   ```
2. Apply migrations against production:
   ```bash
   npx wrangler d1 migrations apply trip-vara --remote
   ```
3. Set the secrets:
   ```bash
   npx wrangler secret put GHL_API_TOKEN
   npx wrangler secret put RESEND_API_KEY
   ```
4. Push to `main`. Cloudflare Workers Builds deploys it.
5. Point `tripvaratravel.com` at the Worker and promote your admin account.

### Secrets

| Secret | Required | Purpose |
| --- | --- | --- |
| `GHL_API_TOKEN` | For leads and pipeline | GoHighLevel Private Integration Token. Without it those two pages show a setup notice; everything else works. |
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
response, so the rest of the portal never depends on GHL's field naming.

---

## Layout

```
src/
  worker.js     Router, auth gate on /app and /admin, static asset serving
  auth.js       Signup, sign in, sessions, password reset, requireUser/requireAdmin
  db.js         Every D1 query
  ghl.js        GoHighLevel client and response normalizers
  leads.js      Contacts and notes
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
