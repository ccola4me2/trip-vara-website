/**
 * Contract check: does every field a page reads actually exist in the API
 * response that page consumes?
 *
 * This exists because of a real bug. A rename moved paymentStats from
 * collectedCents to postedCents, a follow-up edit to the page silently failed
 * to apply, and two figures on the Payments screen rendered as zero. Nothing
 * threw. The page looked fine. It was only caught by someone reading it.
 *
 * Static types would catch this in a typed codebase. This one is deliberately
 * plain JavaScript with no build step, so the equivalent guarantee has to come
 * from asking the running server what it actually returns.
 *
 * Usage: node scripts/check-contracts.mjs [baseUrl] [email] [password]
 */

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const EMAIL = process.argv[3] || 'local@test.dev';
const PASSWORD = process.argv[4] || 'local-test-12345';

import { readFileSync } from 'node:fs';

// Which endpoint feeds which page.
const PAGES = [
  ['public/app/index.html', ['/api/dashboard', '/api/month']],
  ['public/app/payments.html', ['/api/payments?state=all']],
  ['public/app/reservations.html', ['/api/bookings', '/api/groups?status=open',
    '/api/catalog/lines', '/api/catalog/ships?line=Margaritaville at Sea',
    '/api/catalog/dates?ship=Islander']],
  ['public/app/groups.html', ['/api/groups']],
  ['public/app/credits.html', ['/api/credits?state=all', '/api/bookings']],
  ['public/app/goals.html', ['/api/goals']],
  ['public/app/commissions.html', ['/api/commissions']],
  ['public/app/client.html', ['detail-client:/api/bookings']],
  ['public/app/clients.html', ['/api/clients']],
  ['public/app/complete.html', ['/api/bookings', '/api/catalog/suggest']],
  ['public/app/reservation.html', ['detail-record:/api/bookings',
    'post:|/api/payments?state=outstanding|/api/payments/{id}/remind']],
  ['public/app/tasks.html', ['/api/tasks?state=all', '/api/bookings']],
  ['public/app/billing.html', ['/api/billing']],
  ['public/app/reports.html', ['/api/reports/production?months=12']],
  ['public/app/leads.html', ['/api/leads']],
  ['public/app/contact.html', ['/api/leads', '/api/workflows']],
  ['public/app/pipeline.html', ['/api/opportunities', '/api/leads']],
  ['public/app/calendar.html', ['/api/calendar?days=30', '/api/leads']],
  ['public/app/inbox.html', ['/api/conversations']],
  ['public/app/marketing.html', ['/api/marketing']],
  ['public/app/catalog.html', ['/api/catalog']],
  ['public/app/library.html', ['/api/library']],
  ['public/app/account.html', ['/api/account']],
  // These pages also read a detail endpoint, so both shapes count.
  ['public/app/formbuilder.html', ['/api/myforms', 'detail:/api/myforms/{formId}']],
  ['public/app/automations.html', ['/api/automations', 'detail:/api/automations/{automationId}']],
  ['public/admin/index.html', ['/api/admin/advisors', '/api/admin/sync']],
];

// Property names that belong to the DOM, JS builtins or local objects rather
// than to an API response. Without this the signal drowns in noise.
const IGNORE = new Set(`
length map filter reduce forEach join slice split replace trim toFixed push pop
includes some every find findIndex sort concat indexOf toLowerCase toUpperCase
innerHTML textContent value checked disabled hidden dataset classList style
addEventListener querySelector querySelectorAll getElementById appendChild remove
setAttribute getAttribute options selectedIndex elements reset showModal close
then catch finally json text status ok headers body message stack
toISOString getTime getFullYear toLocaleDateString toLocaleTimeString toDateString
padStart repeat match matchAll test exec keys values entries prototype
href location origin search pathname target scrollIntoView focus blur
firstChild lastChild parentElement nextElementSibling previousElementSibling
constructor hasOwnProperty toString valueOf now random floor ceil round abs min max
isArray fromEntries createElement className scrollTop scrollHeight isNaN isFinite
isInteger parse stringify
writeText clipboard currentTarget preventDefault stopPropagation replaceChildren
replaceState pushState scrollIntoView setSelectionRange getSetCookie closest
dataTransfer effectAllowed setData getData draggable insertBefore appendChild
getUTCDay getUTCDate getUTCMonth getUTCFullYear queueMicrotask
setTimeout clearTimeout requestSubmit
gridTemplateColumns cssText selectedOptions
data detail error code redirect
`.trim().split(/\s+/));

/** Every key appearing anywhere in a response, at any depth. */
function collectKeys(value, out = new Set(), depth = 0) {
  if (depth > 6 || value === null || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const v of value.slice(0, 5)) collectKeys(v, out, depth + 1);
    return out;
  }
  for (const [k, v] of Object.entries(value)) {
    out.add(k);
    collectKeys(v, out, depth + 1);
  }
  return out;
}

/**
 * Property accesses inside the page's inline module script.
 *
 * String and template literals are blanked first. Without that a trigger name
 * like "booking.final_payment_due" sitting in an option value reads as a
 * property access on an object called booking, and the checker reports a field
 * that was never a field.
 */
function collectAccesses(html) {
  let script = html.slice(html.indexOf('<script type="module">'));
  // Quoted strings are stripped because trigger names like
  // 'booking.final_payment_due' read as property access otherwise.
  //
  // Template literals are deliberately NOT stripped. Nearly every field
  // reference on these pages lives inside one, as ${money(s.postedCents)} in
  // an innerHTML block. An earlier version of this script blanked them and was
  // therefore blind to the exact code it exists to check: it passed while the
  // bug it was written for sat in the file.
  script = script
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/^\s*\/\/[^\n]*/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  // Fields the page builds itself, spotted as object-literal keys. statusOf
  // returns { label, tone, atRisk }; atRisk is the page's own vocabulary and
  // has no business being looked for in an API response.
  const local = new Set();
  for (const m of script.matchAll(/(?:^|[{,]\s*)([a-zA-Z_$][\w$]*)\s*:/gm)) local.add(m[1]);

  const out = new Set();
  for (const m of script.matchAll(/\b[a-zA-Z_$][\w$]*\.([a-z][a-zA-Z0-9_]*)\b/g)) {
    if (!local.has(m[1])) out.add(m[1]);
  }
  return out;
}

/**
 * True when a response actually contains rows to learn a shape from.
 *
 * Only a populated array proves anything. An empty table and a misspelled
 * field look identical otherwise, and reporting the second when it is the
 * first is what makes a checker not worth running. The `unavailable` marker
 * is skipped because it is a map of booleans, not data.
 */
function hasSampleRows(value, depth = 0) {
  if (depth > 4 || value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) {
    return value.some((v) => v && typeof v === 'object' && Object.keys(v).length > 0);
  }
  return Object.entries(value).some(([k, v]) => k !== 'unavailable' && hasSampleRows(v, depth + 1));
}

/**
 * Names of the arrays in a response that came back empty.
 *
 * A response is not uniformly verifiable. The form detail endpoint answers
 * with a populated `form.fields` and an empty `submissions`, and the old
 * hasSampleRows saw one populated array anywhere and declared the whole
 * response fit to judge. It then reported `contactId`, a field that only ever
 * appears on a submission, as one the API does not return. It does return it;
 * there was simply no submission to carry it.
 *
 * Rather than pretend to know which collection each field came from, the
 * checker names the empty ones and downgrades a mismatch to a warning when
 * any exist. Certainty it does not have is worse than a gap it admits to.
 */
function emptyCollections(value, path = '', out = [], depth = 0) {
  if (depth > 4 || value === null || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    if (!value.length) out.push(path || 'response');
    else value.slice(0, 5).forEach((v) => emptyCollections(v, path, out, depth + 1));
    return out;
  }
  for (const [k, v] of Object.entries(value)) {
    if (k === 'unavailable') continue;
    emptyCollections(v, path ? `${path}.${k}` : k, out, depth + 1);
  }
  return out;
}

async function main() {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
  if (!cookie.includes('tv_session')) {
    console.error('Could not sign in. Is the dev server running with a seeded admin?');
    process.exit(2);
  }

  let problems = 0;
  let unverified = 0;

  for (const [file, endpoints] of PAGES) {
    let html;
    try { html = readFileSync(file, 'utf8'); } catch { continue; }

    const have = new Set();
    const empties = new Set();
    let sampled = true;
    let called = 0;
    let skipped = null;

    for (let endpoint of endpoints) {
      if (endpoint.startsWith('post:')) {
        // A POST that answers with data rather than performing an action: the
        // reminder preview is the case. Without this the checker sees a page
        // reading fields no GET returns and calls it a mismatch, which is the
        // checker being wrong rather than the page.
        const [, listPath, itemPath] = endpoint.split('|');
        const listRes = await fetch(BASE + listPath, { headers: { Cookie: cookie } });
        if (!listRes.ok) continue;
        const list = await listRes.json();
        const first = Object.values(list).find((v) => Array.isArray(v) && v.length)?.[0];
        if (!first || !first.id) continue;
        const r = await fetch(BASE + itemPath.replace('{id}', first.id), {
          method: 'POST',
          headers: { Cookie: cookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ preview: true }),
        });
        if (!r.ok) { skipped = `${itemPath} returned ${r.status}`; continue; }
        called += 1;
        const payload = await r.json();
        collectKeys(payload, have);
        if (!hasSampleRows(payload)) sampled = false;
        for (const name of emptyCollections(payload)) empties.add(name);
        continue;
      }
      if (endpoint.startsWith('detail-client:')) {
        // The client record is keyed on a name rather than an id.
        const listRes = await fetch(BASE + endpoint.replace(/^detail-client:/, ''), { headers: { Cookie: cookie } });
        if (!listRes.ok) continue;
        const list = await listRes.json();
        const first = Object.values(list).find((v) => Array.isArray(v) && v.length)?.[0];
        if (!first || !first.client_name) continue;
        endpoint = `/api/client?name=${encodeURIComponent(first.client_name)}`;
      } else if (endpoint.startsWith('detail-record:')) {
        // Same trick as detail:, but the id hangs a sub resource off the item.
        const listRes = await fetch(BASE + endpoint.replace(/^detail-record:/, ''), { headers: { Cookie: cookie } });
        if (!listRes.ok) continue;
        const list = await listRes.json();
        const first = Object.values(list).find((v) => Array.isArray(v) && v.length)?.[0];
        if (!first || !first.id) continue;
        endpoint = `${endpoint.replace(/^detail-record:/, '')}/${first.id}/record`;
      } else if (endpoint.startsWith('detail:')) {
        // Resolve {id} from the list endpoint before calling the detail one.
        const listPath = endpoints[0];
        const listRes = await fetch(BASE + listPath, { headers: { Cookie: cookie } });
        if (!listRes.ok) continue;
        const list = await listRes.json();
        const first = Object.values(list).find((v) => Array.isArray(v) && v.length)?.[0];
        if (!first || !first.id) continue;
        endpoint = endpoint.replace(/^detail:/, '').replace(/\{[^}]+\}/, first.id);
      }

      const r = await fetch(BASE + endpoint, { headers: { Cookie: cookie } });
      if (!r.ok) { skipped = `${endpoint} returned ${r.status}`; continue; }
      called += 1;
      const payload = await r.json();
      collectKeys(payload, have);
      if (!hasSampleRows(payload)) sampled = false;
      for (const name of emptyCollections(payload)) empties.add(name);
    }

    if (!called) {
      console.log(`SKIP  ${file}${skipped ? '  (' + skipped + ')' : ''}`);
      continue;
    }

    // With no rows in the response we cannot tell a wrong field name from an
    // empty table, and guessing produces exactly the false alarms that make a
    // checker worth ignoring.
    if (!sampled) {
      unverified += 1;
      console.log(`~     ${file}  (no rows in one or more responses; not verifiable here)`);
      continue;
    }

    const used = collectAccesses(html);

    // Only flag names that look like API fields: camelCase or snake_case
    // words the response does not contain anywhere.
    const missing = [...used].filter((f) =>
      !have.has(f) && !IGNORE.has(f) && /^[a-z][a-zA-Z0-9_]{2,}$/.test(f) &&
      (/[A-Z_]/.test(f) || have.size === 0)
    );

    if (missing.length && empties.size) {
      // Part of the response came back empty, so some of these fields may
      // simply have had no row to appear on. Say so instead of guessing.
      unverified += 1;
      console.log(`\n~     ${file}`);
      for (const f of missing) console.log(`        reads .${f}, not seen in the response`);
      console.log(`        empty in this environment: ${[...empties].join(', ')}`);
    } else if (missing.length) {
      problems += missing.length;
      console.log(`\nFAIL  ${file}`);
      for (const f of missing) console.log(`        reads .${f}, response has no such field`);
    } else {
      console.log(`ok    ${file}`);
    }
  }

  console.log(
    problems
      ? `\n${problems} contract mismatch(es).`
      : `\nAll verifiable page contracts match.${unverified ? ` ${unverified} page(s) had no sample data to check against.` : ''}`
  );
  process.exit(problems ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
