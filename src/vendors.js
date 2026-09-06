// Vendors, and the terms they trade on.
//
// Two jobs. The first is spelling: a vendor typed three ways is three vendors
// to every report that groups by the name, and merging them is the only way to
// make those reports true. The second is terms. Every vendor has a rule for
// when the balance falls due, and holding it here turns a reservation with no
// final payment date from a guess into an answer.

import { json, badRequest, notFound, clean, uid, now, readJson } from './util.js';
import { requireUser } from './auth.js';
import * as db from './db.js';

const COLUMNS = `
  v.id, v.user_id, v.name, v.final_days, v.deposit_days, v.commission_pct,
  v.phone, v.email, v.portal_url, v.notes, v.created_at, v.updated_at,
  v.category, v.favourite, v.bdm_name, v.bdm_email, v.bdm_phone,
  v.signup_url, v.website, v.account_number
`;

// The shelves a directory of suppliers falls into. Fixed, because a free text
// category becomes "Cruise", "Cruises" and "Cruise Line" within a fortnight,
// which is the same mess vendors were created to end. Anything unrecognised
// lands in Other rather than being refused.
export const CATEGORIES = [
  'Cruise Lines',
  'All-Inclusive Resorts',
  'Hotels and Resorts',
  'Escorted Tours',
  'River Cruise',
  'Expedition and Yacht',
  'Excursions and Attractions',
  'Villas and Rentals',
  'Rail',
  'Car and Transfers',
  'Air Consolidators',
  'Insurance',
  'Destination Management',
  'Other',
];

/** The vendor record for a name, made if it is new. */
export async function resolveVendor(env, userId, name) {
  const value = String(name || '').trim().slice(0, 120);
  if (!value) return null;

  const existing = await env.DB.prepare(
    'SELECT id FROM vendors WHERE user_id = ? AND name = ?'
  ).bind(userId, value).first().catch(() => null);
  if (existing) return existing.id;

  const ts = now();
  await env.DB.prepare(
    'INSERT OR IGNORE INTO vendors (id, user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(uid(), userId, value, ts, ts).run();

  const row = await env.DB.prepare(
    'SELECT id FROM vendors WHERE user_id = ? AND name = ?'
  ).bind(userId, value).first();
  return row ? row.id : null;
}

export async function handleListVendors(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const scope = db.scopeFor(env, user, request);
  const scoped = db.scopeWhere(scope, 'v.user_id');

  const { results } = await env.DB.prepare(
    `SELECT ${COLUMNS},
            (SELECT COUNT(*) FROM bookings b WHERE b.vendor_id = v.id
              AND b.status IN ('booked','travelled')) AS trips,
            (SELECT COALESCE(SUM(b.gross_cents), 0) FROM bookings b WHERE b.vendor_id = v.id
              AND b.status IN ('booked','travelled')) AS gross_cents,
            (SELECT COALESCE(SUM(b.commission_cents), 0) FROM bookings b WHERE b.vendor_id = v.id
              AND b.status IN ('booked','travelled')) AS commission_cents,
            (SELECT COUNT(*) FROM bookings b WHERE b.vendor_id = v.id
              AND b.status IN ('quoted','booked') AND b.final_payment_due IS NULL) AS undated
       FROM vendors v
      WHERE ${scoped.sql}
      ORDER BY gross_cents DESC, v.name ASC LIMIT 500`
  ).bind(...scoped.binds).all();

  const vendors = results || [];
  return json({
    vendors,
    categories: CATEGORIES,
    stats: {
      total: vendors.length,
      favourites: vendors.filter((v) => v.favourite).length,
      withTerms: vendors.filter((v) => v.final_days).length,
      unused: vendors.filter((v) => !v.trips).length,
      // Names that look like the same vendor written differently. Suggested
      // rather than merged: "Celebrity Cruises" and "Celebrity Cruises Ocean"
      // may be one vendor or two, and only the advisor knows.
      // Only the caller's own, and only within one advisor. An owner viewing
      // the agency sees two advisors' "Carnival" as two rows, which is right:
      // they are two records, and merging is scoped to the owner of them.
      possibleDuplicates: findDuplicates(vendors.filter((v) => v.user_id === user.id)),
    },
    scope: db.scopeLabel(scope, user),
    advisors: await db.advisorOptions(env, user),
  });
}

/**
 * Names that differ only by punctuation, case, or one being a prefix.
 *
 * Callers pass one advisor's vendors. Grouping across advisors would offer a
 * merge that cannot happen, since the merge is scoped to the owner of the
 * records and would quietly move nothing.
 */
function findDuplicates(vendors) {
  const key = (n) => String(n || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const groups = [];
  const used = new Set();

  for (let i = 0; i < vendors.length; i++) {
    if (used.has(vendors[i].id)) continue;
    const a = key(vendors[i].name);
    const group = [vendors[i]];
    for (let j = i + 1; j < vendors.length; j++) {
      if (used.has(vendors[j].id)) continue;
      const b = key(vendors[j].name);
      if (!a || !b) continue;
      if (a === b || a.startsWith(b) || b.startsWith(a)) {
        group.push(vendors[j]);
        used.add(vendors[j].id);
      }
    }
    if (group.length > 1) {
      used.add(vendors[i].id);
      groups.push(group.map((v) => ({ id: v.id, name: v.name, trips: v.trips })));
    }
  }
  return groups;
}

export async function handleUpdateVendor(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const name = clean(body.name, 120);
  if (!name) return badRequest('A vendor needs a name.');

  const num = (v, max) => {
    if (v === '' || v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 && n <= max ? n : null;
  };

  // Only http and https, and only when it parses. A link typed into a
  // directory is clicked without being read, so a javascript: URL saved here
  // would be a script the advisor runs on themselves.
  const link = (v) => (/^https?:\/\//i.test(String(v || '')) ? clean(v, 300) : null);

  const res = await env.DB.prepare(
    `UPDATE vendors SET name = ?, final_days = ?, deposit_days = ?, commission_pct = ?,
       phone = ?, email = ?, portal_url = ?, notes = ?, category = ?,
       bdm_name = ?, bdm_email = ?, bdm_phone = ?, signup_url = ?, website = ?,
       account_number = ?, updated_at = ?
     WHERE id = ? AND user_id = ?`
  ).bind(name, num(body.finalDays, 730), num(body.depositDays, 365), num(body.commissionPct, 100),
         clean(body.phone, 40) || null, clean(body.email, 160) || null,
         link(body.portalUrl),
         clean(body.notes, 2000) || null,
         CATEGORIES.includes(String(body.category)) ? String(body.category) : null,
         // favourite is deliberately absent. It has its own endpoint, and
         // writing it here from a form that has no star field cleared the star
         // every time a vendor was edited.
         clean(body.bdmName, 120) || null, clean(body.bdmEmail, 160) || null,
         clean(body.bdmPhone, 40) || null,
         link(body.signupUrl), link(body.website),
         clean(body.accountNumber, 60) || null,
         now(), id, user.id).run();
  if (!res.meta || res.meta.changes === 0) return notFound('Vendor not found.');

  // The name is what every report groups by and what a vendor prints on a
  // confirmation, so renaming has to carry the reservations with it.
  await env.DB.prepare('UPDATE bookings SET supplier = ? WHERE vendor_id = ? AND user_id = ?')
    .bind(name, id, user.id).run().catch(() => {});

  return json({ ok: true });
}

/**
 * Star or unstar a vendor.
 *
 * Its own endpoint rather than a field on the full save, because starring is
 * one click on a directory of two hundred suppliers and sending the whole
 * record back to toggle a flag would let a stale form overwrite the rest of it.
 */
export async function handleFavouriteVendor(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const res = await env.DB.prepare(
    'UPDATE vendors SET favourite = ?, updated_at = ? WHERE id = ? AND user_id = ?'
  ).bind(body.favourite ? 1 : 0, now(), id, user.id).run();

  if (!res.meta || res.meta.changes === 0) return notFound('Vendor not found.');
  return json({ ok: true, favourite: Boolean(body.favourite) });
}

/**
 * Fold one vendor into another.
 *
 * Rewrites the name on every reservation as well as repointing them, because
 * the reports group by the string. Doing only one of the two leaves the totals
 * looking merged on one screen and split on another, which is worse than
 * leaving them alone.
 */
export async function handleMergeVendors(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const keepId = clean(body.keep, 64);
  const dropIds = Array.isArray(body.drop)
    ? body.drop.filter((x) => typeof x === 'string' && x !== keepId).slice(0, 50) : [];
  if (!keepId || !dropIds.length) return badRequest('Pick one vendor to keep and at least one to fold in.');

  const keep = await env.DB.prepare('SELECT id, name FROM vendors WHERE id = ? AND user_id = ?')
    .bind(keepId, user.id).first();
  if (!keep) return notFound('Vendor not found.');

  const marks = dropIds.map(() => '?').join(',');
  const moved = await env.DB.prepare(
    `UPDATE bookings SET vendor_id = ?, supplier = ?, updated_at = ?
      WHERE user_id = ? AND vendor_id IN (${marks})`
  ).bind(keepId, keep.name, now(), user.id, ...dropIds).run();

  await env.DB.prepare(`DELETE FROM vendors WHERE user_id = ? AND id IN (${marks})`)
    .bind(user.id, ...dropIds).run();

  const changed = moved.meta ? moved.meta.changes || 0 : 0;
  await db.logActivity(env, user.id, 'vendor.merge',
    `Folded ${dropIds.length} vendor${dropIds.length === 1 ? '' : 's'} into ${keep.name}`,
    { keep: keepId, moved: changed });

  return json({ ok: true, keptName: keep.name, mergedFrom: dropIds.length, reservationsMoved: changed });
}

/**
 * Final payment dates the vendor's own terms imply.
 *
 * Suggested, never applied silently. A vendor's standard terms are a good
 * guess and not a fact: a group booking, a promotion or a late booking all
 * move the real date, and a date written into the record by software is
 * indistinguishable afterwards from one an advisor confirmed.
 */
export async function handleSuggestDates(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const scope = db.selfScope(user);
  const scoped = db.scopeWhere(scope, 'b.user_id');
  const { results } = await env.DB.prepare(
    `SELECT b.id, b.client_name, b.supplier, b.depart_date, b.final_payment_due,
            v.final_days, v.name AS vendor_name
       FROM bookings b JOIN vendors v ON v.id = b.vendor_id
      WHERE ${scoped.sql} AND b.status IN ('quoted','booked')
        AND b.final_payment_due IS NULL AND b.depart_date IS NOT NULL
        AND v.final_days IS NOT NULL
      ORDER BY b.depart_date ASC LIMIT 300`
  ).bind(...scoped.binds).all().catch(() => ({ results: [] }));

  const today = new Date().toISOString().slice(0, 10);
  const suggestions = (results || []).map((r) => {
    const due = new Date(Date.parse(`${r.depart_date}T00:00:00Z`) - r.final_days * 86400000)
      .toISOString().slice(0, 10);
    return {
      id: r.id,
      clientName: r.client_name,
      vendor: r.vendor_name,
      departDate: r.depart_date,
      finalDays: r.final_days,
      suggested: due,
      // A date already behind us is not a deadline, it is a warning that this
      // booking was taken inside the vendor's window.
      alreadyPassed: due < today,
    };
  });

  return json({ suggestions, today });
}
