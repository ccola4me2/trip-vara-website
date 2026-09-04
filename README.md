# Trip Vara Website

Marketing and lead generation site for **Trip Vara** (tripvaratravel.com), the
travel advisory run by Brent Beasley, an independent travel advisor affiliated
with Cruise Planners. Specialises in Margaritaville at Sea, and books cruises,
resorts and group travel generally.

Built with Next.js (App Router), TypeScript and Tailwind CSS. Deploy ready for
Vercel.

---

## Quick start

Requires Node.js 18.18 or newer.

```bash
npm install
cp .env.example .env.local
npm run dev
```

Open http://localhost:3000.

| Command | What it does |
| --- | --- |
| `npm run dev` | Local dev server with hot reload |
| `npm run build` | Production build |
| `npm start` | Serve the production build |
| `npm run typecheck` | TypeScript check with no emit |

---

## Environment variables

Copy `.env.example` to `.env.local` for local work, and add the same values in
the Vercel project settings for deployments.

| Variable | Required | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_SITE_URL` | Recommended | Canonical URL used by metadata, `sitemap.xml` and Open Graph tags. Defaults to `https://tripvaratravel.com`. |
| `NEXT_PUBLIC_GHL_FORM_ID` | Yes, for the quote form | GoHighLevel form id. |
| `NEXT_PUBLIC_GHL_CALENDAR_ID` | Yes, for booking | GoHighLevel calendar id. |

Until the two GHL ids are set, `/quote`, `/contact` and `/book` render a clearly
labelled setup notice in place of the embed rather than a broken iframe.

---

## GoHighLevel integration

The site connects to the **Trip Vara** GHL sub-account.

- Location ID: `4Hb35fhCOJSuOmKDA1bY` (hardcoded in `src/config/ghl.ts`)
- Dashboard: https://app.concinnity.digital/v2/location/4Hb35fhCOJSuOmKDA1bY/dashboard

### Finding the form id

1. In GHL, open **Sites**, then **Forms**.
2. Open the quote form and choose **Integrate**.
3. The embed code contains a URL like
   `https://api.leadconnectorhq.com/widget/form/<FORM_ID>`.
4. Put `<FORM_ID>` in `NEXT_PUBLIC_GHL_FORM_ID`.

### Finding the calendar id

1. In GHL, open **Calendars** and select the discovery call calendar.
2. Choose **Embed**.
3. The embed code contains a URL like
   `https://api.leadconnectorhq.com/widget/booking/<CALENDAR_ID>`.
4. Put `<CALENDAR_ID>` in `NEXT_PUBLIC_GHL_CALENDAR_ID`.

Both embeds live in `src/components/GhlEmbed.tsx` and load the LeadConnector
resize script lazily, so they do not block first paint.

---

## Project structure

```
src/
  app/
    layout.tsx          Root layout, fonts, metadata, JSON-LD
    page.tsx            Home
    about/              Brent's story, credentials
    cruises/            Cruises and destinations, Margaritaville pinned
    quote/              Primary conversion page, GHL form
    book/               GHL calendar booking
    testimonials/       Reviews
    contact/            Contact details plus GHL form
    sitemap.ts          Generates /sitemap.xml
    robots.ts           Generates /robots.txt
    opengraph-image.tsx Generated social sharing card
    icon.svg            Favicon
    globals.css         Tailwind theme, brand tokens, photo placeholders
  components/           Reusable UI
  config/
    site.ts             Business details, navigation, contact info
    ghl.ts              CRM ids and embed URLs
  content/
    destinations.ts     Destination cards
    cruise-lines.ts     Cruise lines and services
    testimonials.ts     Client reviews
public/
  logo-mark.svg
  images/README.md      How to swap placeholders for real photography
```

## Editing content

Most copy changes do not require touching a page component.

- **Business details, contact info, social links, navigation:** `src/config/site.ts`
- **Destinations shown on Home and Cruises:** `src/content/destinations.ts`
- **Cruise lines and service list:** `src/content/cruise-lines.ts`
- **Reviews:** `src/content/testimonials.ts`

Fields left as empty strings are treated as "not set" and their UI is hidden, so
the site never shows a blank phone number or a dead social link.

---

## Before launch

- [ ] Add the real GHL form and calendar ids
- [ ] Confirm the published email address and add a phone number in `src/config/site.ts`
- [ ] Add real social profile URLs
- [ ] Replace the placeholder reviews in `src/content/testimonials.ts` with real, attributable ones
- [ ] Swap `PhotoFrame` placeholders for real photography (see `public/images/README.md`)
- [ ] Replace the rebuilt logo vectors with the original artwork if available
- [ ] Confirm state Seller of Travel registration wording in the footer

---

## Brand

Taken from the Trip Vara logo. Tokens are defined in `src/app/globals.css`.

| Role | Token | Hex |
| --- | --- | --- |
| Primary navy | `navy-800` | `#1b3a5f` |
| Deep navy | `navy-900` / `navy-950` | `#12294a` / `#0a1a30` |
| Coral accent | `coral-400` | `#f1705b` |
| Warm sand | `sand-100` | `#f7f0e4` |
| Page background | `shell` | `#fbf9f5` |

Headings use **Montserrat**, matching the wordmark. Body copy uses **Inter**.
Both are loaded through `next/font`, so there is no external stylesheet request.

---

## Deploying to Vercel

1. Import the repository at https://vercel.com/new.
2. Framework preset: **Next.js**. Build command and output directory are detected
   automatically.
3. Add the environment variables listed above.
4. Add `tripvaratravel.com` and `www.tripvaratravel.com` as domains, then point
   DNS at Vercel.
5. After the first deploy, confirm `/sitemap.xml` and `/robots.txt` resolve, and
   submit the sitemap in Google Search Console.
