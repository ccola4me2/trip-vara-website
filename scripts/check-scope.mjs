// Can one advisor reach another advisor's data?
//
// The rule this portal is built on is small and easy to break: a read may
// widen to the whole agency when an owner asks, and every write is confined to
// the caller. Both halves live in the same helpers (scopeWhere, selfScope), so
// the failure mode is not a wrong scope but a missing one: a query written
// without any user predicate at all, which quietly returns or changes
// everybody's rows and looks perfectly normal in testing on one account.
//
// Nothing else catches it. The smoke test signs in as two people and checks
// what each can see, which covers the endpoints somebody thought to test; this
// covers every statement in the codebase, including the ones added since.
//
// A statement touching a table that belongs to a user must name user_id, or
// interpolate one of the scope helpers, or be listed below with a reason.
// "It is only ever called with an id we already checked" is a reason, and it
// has to be written down rather than assumed.
//
//   node scripts/check-scope.mjs

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Tables whose rows belong to one advisor.
const OWNED = new Set([
  'bookings', 'booking_payments', 'booking_pricing', 'travellers', 'amenities',
  'tasks', 'client_credits', 'clients', 'travel_groups', 'vendors', 'goals',
  'user_prefs', 'reminders',
]);

// Tables that belong to a GoHighLevel sub-account rather than to one advisor.
// A whole agency shares these, so location_id is the predicate that matters.
const LOCATION_OWNED = new Set(['forms', 'form_submissions']);

// Statements that touch an owned table without naming a user, and why that is
// correct. Matched on a distinctive fragment of the SQL. Every entry is a
// claim that somebody checked, which is the point of writing it down instead
// of widening the rule until nothing fails.
const ALLOWED = [
  ['UPDATE travellers SET is_lead = 0', 'follows an ownership check on the traveller being promoted'],
  ['UPDATE bookings SET travellers =', 'called only after the booking was fetched for this user'],
  ['UPDATE bookings SET gross_cents', 'called only after the booking was fetched for this user'],
  ['SELECT COUNT(*) AS n FROM travellers', 'counts rows on a booking already resolved for this user'],
  ['FROM travel_groups WHERE id = ?', 'the group id comes off a reservation already read in scope'],
  ['SELECT name, commission_pct FROM vendors WHERE id = ?',
    'the vendor id comes off a reservation already read in scope'],
  ['UPDATE clients SET ghl_contact_id = ?', 'the id came from a SELECT filtered by user_id'],
  ['FROM forms WHERE slug = ?',
    'a form slug is global because the public URL it serves is global'],
  ['UPDATE form_submissions SET contact_id = ? WHERE id = ?',
    'the id is the submission this request just inserted'],
  ['AS lifetime_cents',
    'the outer WHERE is built from scopeWhere; the bookings subqueries reach only this user\'s clients'],
];

function sqlStatements(src) {
  const out = [];
  const marker = 'env.DB.prepare(';
  let at = src.indexOf(marker);

  while (at !== -1) {
    let i = at + marker.length;
    while (i < src.length && /\s/.test(src[i])) i += 1;
    const quote = src[i];
    if (quote === '`' || quote === "'" || quote === '"') {
      i += 1;
      let sql = '';
      while (i < src.length) {
        if (src[i] === '\\') { sql += src[i] + src[i + 1]; i += 2; continue; }
        if (src[i] === quote) break;
        sql += src[i];
        i += 1;
      }
      out.push({ sql, line: src.slice(0, at).split('\n').length });
    }
    at = src.indexOf(marker, at + marker.length);
  }
  return out;
}

/** Every table named by a FROM, JOIN, UPDATE, INSERT INTO or DELETE FROM. */
function tablesIn(sql) {
  const found = new Set();
  const patterns = [
    /\bFROM\s+([A-Za-z_][\w]*)/gi,
    /\bJOIN\s+([A-Za-z_][\w]*)/gi,
    /\bUPDATE\s+([A-Za-z_][\w]*)/gi,
    /\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+([A-Za-z_][\w]*)/gi,
    /\bDELETE\s+FROM\s+([A-Za-z_][\w]*)/gi,
  ];
  for (const p of patterns) {
    for (const m of sql.matchAll(p)) found.add(m[1]);
  }
  return found;
}

const files = readdirSync(join(ROOT, 'src')).filter((f) => f.endsWith('.js')).sort();
let checked = 0;
let problems = 0;

for (const file of files) {
  const src = readFileSync(join(ROOT, 'src', file), 'utf8');

  for (const { sql, line } of sqlStatements(src)) {
    const all = tablesIn(sql);
    const tables = [...all].filter((t) => OWNED.has(t));
    const byLocation = [...all].filter((t) => LOCATION_OWNED.has(t));
    if (!tables.length && !byLocation.length) continue;

    checked += 1;

    // A location table is answered by location_id, or by a form_id belonging
    // to a form the caller already proved is theirs.
    if (!tables.length) {
      if (/\blocation_id\b/.test(sql) || /\bform_id\b/.test(sql)) continue;
    }

    // Named directly, or through one of the helpers that writes the predicate.
    // `${scoped.sql}` is the usual shape; the calendar builds several at once
    // and names them b, t and g, so any `${x.sql}` counts.
    const viaHelper = /\$\{[^}]*[Ss]cope[^}]*\}/.test(sql)
      || /\$\{[A-Za-z_$][\w$]*\.sql\}/.test(sql);
    const namesUser = /\buser_id\b/.test(sql);

    // The other half of the rule, and the half that is a privilege bug rather
    // than a privacy one. A read may widen to the whole agency when an owner
    // asks; a write may not, ever. An owner may see an associate's
    // reservation and may not change it, and the two would quietly become one
    // permission the moment a write borrowed the reading scope. Every write in
    // this codebase names user_id outright, and this keeps it that way.
    if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) {
      if (namesUser && !viaHelper) continue;
      const excused = ALLOWED.find(([fragment]) => sql.includes(fragment));
      if (excused) continue;
      problems += 1;
      console.log(`FAIL  src/${file}:${line}  writes to ${tables.join(', ')} ${
        viaHelper ? 'through a scope helper, which can widen past the caller' : 'without naming user_id'}`);
      console.log(`        ${sql.replace(/\s+/g, ' ').trim().slice(0, 140)}`);
      continue;
    }

    if (namesUser || viaHelper) continue;

    const excuse = ALLOWED.find(([fragment]) => sql.includes(fragment));
    if (excuse) continue;

    problems += 1;
    const named = tables.length ? tables.join(', ') : byLocation.join(', ');
    const kind = tables.length ? 'no user predicate' : 'no location predicate';
    console.log(`FAIL  src/${file}:${line}  touches ${named} with ${kind}`);
    console.log(`        ${sql.replace(/\s+/g, ' ').trim().slice(0, 140)}`);
  }
}

console.log('');
if (problems) {
  console.log(`${problems} statement${problems === 1 ? '' : 's'} could reach another advisor's rows.`);
  process.exit(1);
}
console.log(`All ${checked} statements touching owned tables are scoped to a user.`);
