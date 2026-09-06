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
  v.signup_url, v.website, v.account_number,
  v.phones_json, v.commission_structure, v.registration_instructions
`;

// The shelves a directory of suppliers falls into. Fixed, because a free text
// category becomes "Cruise", "Cruises" and "Cruise Line" within a fortnight,
// which is the same mess vendors were created to end. Anything unrecognised
// lands in Other rather than being refused.
// High enough that no real book reaches it, low enough to stay one quick
// query. Reported rather than silently applied when it does bite.
const LIST_CAP = 2000;

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
      ORDER BY gross_cents DESC, v.name ASC LIMIT ?`
    // One over the cap, so a truncated list can be reported as truncated. This
    // page is a directory: it is supposed to list everything, and a silent cut
    // meant a vendor could be added and simply not appear. Found by adding one.
  ).bind(...scoped.binds, LIST_CAP + 1).all();

  const all = results || [];
  const truncated = all.length > LIST_CAP;
  const vendors = truncated ? all.slice(0, LIST_CAP) : all;

  return json({
    vendors,
    categories: CATEGORIES,
    truncated,
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

/**
 * The editable fields, read once so create and update cannot disagree.
 *
 * Two parsers for one form is how a field ends up saving on edit and silently
 * dropping on create, which is the same class of bug as two column lists.
 */
function parseVendor(body) {
  const name = clean(body.name, 120);
  if (!name) return { error: 'A vendor needs a name.' };

  const num = (v, max) => {
    if (v === '' || v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 && n <= max ? n : null;
  };

  // Only http and https, and only when it parses. A link in a directory is
  // clicked without being read, so a javascript: URL saved here would be a
  // script the advisor runs on themselves.
  const link = (v) => (/^https?:\/\//i.test(String(v || '')) ? clean(v, 300) : null);

  // Suppliers have several numbers: reservations, groups, after hours. Kept as
  // a list so each one stays dialable, capped so a runaway form cannot store a
  // thousand of them.
  const phones = (Array.isArray(body.phones) ? body.phones : [])
    .map((x) => ({ label: clean(x?.label, 40) || '', number: clean(x?.number, 40) || '' }))
    .filter((x) => x.number)
    .slice(0, 12);

  return {
    fields: {
      name,
      finalDays: num(body.finalDays, 730),
      depositDays: num(body.depositDays, 365),
      commissionPct: num(body.commissionPct, 100),
      phone: clean(body.phone, 40) || null,
      email: clean(body.email, 160) || null,
      portalUrl: link(body.portalUrl),
      website: link(body.website),
      signupUrl: link(body.signupUrl),
      notes: clean(body.notes, 2000) || null,
      category: CATEGORIES.includes(String(body.category)) ? String(body.category) : null,
      bdmName: clean(body.bdmName, 120) || null,
      bdmEmail: clean(body.bdmEmail, 160) || null,
      bdmPhone: clean(body.bdmPhone, 40) || null,
      accountNumber: clean(body.accountNumber, 60) || null,
      phonesJson: phones.length ? JSON.stringify(phones) : null,
      commissionStructure: clean(body.commissionStructure, 4000) || null,
      registrationInstructions: clean(body.registrationInstructions, 4000) || null,
    },
  };
}

/** Add a vendor by hand, rather than waiting to book one. */
export async function handleCreateVendor(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const { fields, error } = parseVendor(body);
  if (error) return badRequest(error);

  // Names are unique per advisor, and a vendor typed twice is the duplicate
  // this table exists to prevent. Answered as a message rather than a
  // constraint violation.
  const clash = await env.DB.prepare(
    'SELECT id FROM vendors WHERE user_id = ? AND LOWER(name) = LOWER(?)'
  ).bind(user.id, fields.name).first();
  if (clash) return badRequest(`You already have a vendor called ${fields.name}.`);

  const id = uid();
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO vendors
       (id, user_id, name, final_days, deposit_days, commission_pct, phone, email,
        portal_url, notes, category, bdm_name, bdm_email, bdm_phone, signup_url,
        website, account_number, phones_json, commission_structure,
        registration_instructions, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, user.id, fields.name, fields.finalDays, fields.depositDays,
         fields.commissionPct, fields.phone, fields.email, fields.portalUrl,
         fields.notes, fields.category, fields.bdmName, fields.bdmEmail,
         fields.bdmPhone, fields.signupUrl, fields.website, fields.accountNumber,
         fields.phonesJson, fields.commissionStructure,
         fields.registrationInstructions, ts, ts).run();

  return json({ ok: true, id });
}

/**
 * Remove a vendor, leaving its reservations alone.
 *
 * The trips keep the supplier name they were sold under, because that is what
 * the client's confirmation says and what every report groups by. Only the
 * link is cut. Deleting the reservations along with the directory entry would
 * destroy real bookings to tidy up a list.
 */
export async function handleDeleteVendor(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  await env.DB.prepare(
    'UPDATE bookings SET vendor_id = NULL WHERE vendor_id = ? AND user_id = ?'
  ).bind(id, user.id).run();

  const res = await env.DB.prepare(
    'DELETE FROM vendors WHERE id = ? AND user_id = ?'
  ).bind(id, user.id).run();

  if (!res.meta || res.meta.changes === 0) return notFound('Vendor not found.');
  return json({ ok: true });
}

export async function handleUpdateVendor(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const { fields, error } = parseVendor(body);
  if (error) return badRequest(error);
  const name = fields.name;

  const res = await env.DB.prepare(
    `UPDATE vendors SET name = ?, final_days = ?, deposit_days = ?, commission_pct = ?,
       phone = ?, email = ?, portal_url = ?, notes = ?, category = ?,
       bdm_name = ?, bdm_email = ?, bdm_phone = ?, signup_url = ?, website = ?,
       account_number = ?, phones_json = ?, commission_structure = ?,
       registration_instructions = ?, updated_at = ?
     WHERE id = ? AND user_id = ?`
    // favourite is deliberately absent. It has its own endpoint, and writing
    // it here from a form that has no star field cleared the star every time
    // a vendor was edited.
  ).bind(name, fields.finalDays, fields.depositDays, fields.commissionPct,
         fields.phone, fields.email, fields.portalUrl, fields.notes,
         fields.category, fields.bdmName, fields.bdmEmail, fields.bdmPhone,
         fields.signupUrl, fields.website, fields.accountNumber,
         fields.phonesJson, fields.commissionStructure,
         fields.registrationInstructions,
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
