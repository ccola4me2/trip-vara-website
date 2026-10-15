// Who is actually coming, and what is still missing from their record.
//
// The registration list answered "somebody put their name down". That was the
// right answer when a registration was a name and an email. Now it carries a
// cabin grade, a party, passports, allergies and an emergency contact, and the
// question an advisor has three weeks before a departure is a different one:
// who has not sent a passport, who has not been rung, and which grade is full.
//
// Passports are masked by default and nothing on the ordinary screen decrypts
// one. The full numbers come out once, deliberately, when a manifest is built
// for the supplier, and that is logged. See docs/encryption.md.
//
// Everything here is read and written at the advisor's own scope, the same as
// every other screen: the registration carries the group owner's user_id, so
// the fence is the ordinary one and nothing about the public page widens it.

import { json, badRequest, notFound, clean, cleanText, cleanDate, oneOf, now, readJson } from './util.js';
import { requireUser } from './auth.js';
import * as db from './db.js';
import { seal, open, masked, piiReady } from './pii.js';
import { REGISTRATION_STATUSES } from './grouppage.js';

/**
 * Everything on one group's roster.
 *
 * One query for the registrations and one for the travellers, joined in the
 * Worker rather than in SQL. A join would repeat the registration's columns
 * once per traveller and then need unpicking, and the shapes the page wants
 * are nested anyway.
 */
export async function handleRoster(request, env, groupId) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const scope = db.scopeFor(env, user, request);
  const gScoped = db.scopeWhere(scope, 'g.user_id');
  const group = await env.DB.prepare(
    `SELECT g.id, g.user_id, g.name, g.passport_due, g.depart_date
       FROM travel_groups g WHERE g.id = ? AND ${gScoped.sql}`
  ).bind(groupId, ...gScoped.binds).first();
  if (!group) return notFound('Group not found.');

  const rScoped = db.scopeWhere(scope, 'r.user_id');
  const { results: regs } = await env.DB.prepare(
    `SELECT r.id, r.name, r.email, r.phone, r.party_size, r.notes, r.booking_id,
            r.rate_id, r.status, r.supplier_ref, r.terms_at, r.created_at,
            rt.room_type AS rate_name
       FROM group_registrations r
       LEFT JOIN group_rates rt ON rt.id = r.rate_id
      WHERE r.group_id = ? AND ${rScoped.sql}
      ORDER BY r.created_at DESC LIMIT 300`
  ).bind(groupId, ...rScoped.binds).all().catch(() => ({ results: [] }));

  const tScoped = db.scopeWhere(scope, 't.user_id');
  const { results: travellers } = await env.DB.prepare(
    `SELECT t.id, t.registration_id, t.name, t.email, t.passport_country,
            t.dietary, t.accessibility, t.emergency_name, t.emergency_phone,
            t.emergency_relation, t.is_lead,
            t.dob_enc, t.passport_number_enc, t.passport_expiry_enc
       FROM group_travellers t
      WHERE t.group_id = ? AND ${tScoped.sql}
      ORDER BY t.is_lead DESC, t.created_at ASC`
  ).bind(groupId, ...tScoped.binds).all().catch(() => ({ results: [] }));

  const byReg = new Map();
  for (const t of travellers || []) {
    if (!byReg.has(t.registration_id)) byReg.set(t.registration_id, []);
    byReg.get(t.registration_id).push(await publicTraveller(env, t));
  }

  const rows = (regs || []).map((r) => {
    const party = byReg.get(r.id) || [];
    return {
      ...r,
      travellers: party,
      // What an advisor is chasing. Counted here rather than on the page so
      // the number and the list cannot disagree.
      missingPassport: party.filter((t) => !t.hasPassport).length,
      missingDob: party.filter((t) => !t.hasDob).length,
    };
  });

  return json({
    group,
    registrations: rows,
    statuses: REGISTRATION_STATUSES,
    // Whether a passport can be recorded at all. The page hides the boxes when
    // it cannot, the same as the public form does, rather than offering
    // somewhere to type that quietly drops what is typed.
    canHoldPassports: piiReady(env),
    counts: {
      parties: rows.length,
      people: rows.reduce((n, r) => n + r.travellers.length, 0),
      missingPassport: rows.reduce((n, r) => n + r.missingPassport, 0),
      booked: rows.filter((r) => r.booking_id).length,
    },
  });
}

/**
 * One traveller, as a screen is allowed to see them.
 *
 * The passport number is masked rather than withheld, because an advisor
 * checking that the right one is on file needs to recognise it and does not
 * need to read it. The expiry is given in full: it is the half that has to be
 * checked against the six month rule, and a date is not an identity document.
 */
async function publicTraveller(env, row) {
  const passport = await open(env, row.passport_number_enc);
  const expiry = await open(env, row.passport_expiry_enc);
  const dob = await open(env, row.dob_enc);
  return {
    id: row.id,
    registration_id: row.registration_id,
    name: row.name,
    email: row.email,
    passport_country: row.passport_country,
    dietary: row.dietary,
    accessibility: row.accessibility,
    emergency_name: row.emergency_name,
    emergency_phone: row.emergency_phone,
    emergency_relation: row.emergency_relation,
    is_lead: row.is_lead,
    passportMasked: masked(passport),
    passportExpiry: expiry,
    dob,
    hasPassport: Boolean(passport),
    hasDob: Boolean(dob),
  };
}

/** Working a registration: where it has got to, and the supplier's reference. */
export async function handleUpdateRegistration(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const owner = await db.writerFor(env, user, 'group_registrations', id);
  if (!owner) return notFound('Registration not found.');

  const body = await readJson(request);
  const status = oneOf(body.status, REGISTRATION_STATUSES) || 'new';

  const res = await env.DB.prepare(
    `UPDATE group_registrations
        SET status = ?, supplier_ref = ?, notes = ?, updated_at = ?
      WHERE id = ? AND user_id = ?`
  ).bind(status, clean(body.supplierRef, 60) || null,
         cleanText(body.notes, 1000) || null, now(), id, owner.id).run();
  if (!res.meta || res.meta.changes === 0) return notFound('Registration not found.');

  return json({ ok: true });
}

/**
 * Filling in what somebody did not have to hand.
 *
 * Most parties register without a passport, because the passport is in a
 * drawer and the cabin is going. The advisor types it in later off an email,
 * and this is where that goes.
 *
 * A blank passport field means "no change", not "delete it". Clearing one is
 * not a thing anybody has asked for, and a save that wiped a passport because
 * a box rendered empty is the partial-save bug this portal has had before.
 */
export async function handleUpdateGroupTraveller(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const owner = await db.writerFor(env, user, 'group_travellers', id);
  if (!owner) return notFound('Traveller not found.');

  const body = await readJson(request);
  const name = clean(body.name, 120);
  if (!name) return badRequest('A traveller needs a name.');

  const wantsSealing = Boolean(clean(body.passportNumber, 40))
    || Boolean(cleanDate(body.passportExpiry)) || Boolean(cleanDate(body.dob));
  if (wantsSealing && !piiReady(env)) {
    return badRequest('Passport details and dates of birth cannot be stored yet. '
      + 'Whoever runs the portal needs to set the encryption key first.');
  }

  const current = await env.DB.prepare(
    `SELECT dob_enc, passport_number_enc, passport_expiry_enc
       FROM group_travellers WHERE id = ? AND user_id = ?`
  ).bind(id, owner.id).first();

  const keepOr = async (value, existing) => {
    const text = clean(value, 60);
    return text ? seal(env, text) : (existing || null);
  };

  const res = await env.DB.prepare(
    `UPDATE group_travellers
        SET name = ?, email = ?, passport_country = ?, dietary = ?, accessibility = ?,
            emergency_name = ?, emergency_phone = ?, emergency_relation = ?,
            dob_enc = ?, passport_number_enc = ?, passport_expiry_enc = ?, updated_at = ?
      WHERE id = ? AND user_id = ?`
  ).bind(name, clean(body.email, 254) || null, clean(body.passportCountry, 60) || null,
         cleanText(body.dietary, 300) || null, cleanText(body.accessibility, 300) || null,
         clean(body.emergencyName, 120) || null, clean(body.emergencyPhone, 40) || null,
         clean(body.emergencyRelation, 60) || null,
         await keepOr(cleanDate(body.dob), current?.dob_enc),
         await keepOr(body.passportNumber, current?.passport_number_enc),
         await keepOr(cleanDate(body.passportExpiry), current?.passport_expiry_enc),
         now(), id, owner.id).run();
  if (!res.meta || res.meta.changes === 0) return notFound('Traveller not found.');

  await db.logActivity(env, owner.id, 'group.traveller.update',
    `Updated ${name} on a group registration`, { id });
  return json({ ok: true });
}

/**
 * Removing a registration, and the people on it.
 *
 * Named rather than cascaded, because D1 does not enforce foreign keys and a
 * registration deleted on its own would leave its travellers behind with their
 * sealed passports and nothing pointing at them.
 */
export async function handleDeleteRegistration(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const owner = await db.writerFor(env, user, 'group_registrations', id);
  if (!owner) return notFound('Registration not found.');

  await env.DB.prepare(
    'DELETE FROM group_travellers WHERE registration_id = ? AND user_id = ?'
  ).bind(id, owner.id).run();
  const res = await env.DB.prepare(
    'DELETE FROM group_registrations WHERE id = ? AND user_id = ?'
  ).bind(id, owner.id).run();
  if (!res.meta || res.meta.changes === 0) return notFound('Registration not found.');

  await db.logActivity(env, owner.id, 'group.registration.delete',
    'Removed a group registration and everybody on it', { id });
  return json({ ok: true });
}
