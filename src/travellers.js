// The people on a reservation, and what the vendor has granted them.
//
// A traveller count is a number. Travellers are people, and the difference
// shows up in three places that matter:
//
//   Documents are issued per person, so a name has to be exactly as it appears
//   on the passport, not as the client says it in conversation.
//
//   A passport that expires within six months of travel is the commonest way
//   a holiday is lost at the airport, and it is the advisor who gets blamed.
//
//   A birthday is a reason to make contact that costs nothing and is welcome.

import { json, badRequest, notFound, clean, cleanDate, oneOf, toCents, uid, now, readJson } from './util.js';
import { requireUser } from './auth.js';
import * as db from './db.js';

const AMENITY_STATUS = ['requested', 'confirmed', 'applied', 'declined'];
const AMENITY_SOURCE = ['vendor', 'agency', 'client'];

const TRAVELLER_COLUMNS = `
  id, booking_id, user_id, name, dob, email, phone, passport_number,
  passport_expiry, passport_country, is_lead, notes, created_at, updated_at
`;

function parseTraveller(body) {
  const name = clean(body.name, 120);
  if (!name) return { error: 'A traveller needs a name.' };
  return {
    fields: {
      name,
      dob: cleanDate(body.dob),
      email: clean(body.email, 160),
      phone: clean(body.phone, 40),
      passportNumber: clean(body.passportNumber, 40),
      passportExpiry: cleanDate(body.passportExpiry),
      passportCountry: clean(body.passportCountry, 60),
      isLead: body.isLead ? 1 : 0,
      notes: clean(body.notes, 1000),
    },
  };
}

/**
 * A passport is a problem if it expires within six months of the return date.
 *
 * Six months is the rule most countries apply, and it is applied on arrival
 * rather than on booking, so a passport that is valid today can still be
 * refused. Reported as a warning against the trip's own dates rather than
 * against today.
 */
export function passportProblem(traveller, returnDate) {
  if (!traveller.passport_expiry || !returnDate) return null;
  const expiry = Date.parse(`${traveller.passport_expiry}T00:00:00Z`);
  const back = Date.parse(`${returnDate}T00:00:00Z`);
  if (!Number.isFinite(expiry) || !Number.isFinite(back)) return null;
  if (expiry < back) return 'expires before they get home';
  if (expiry < back + 182 * 86400000) return 'expires within six months of their return';
  return null;
}

export async function listTravellers(env, bookingId, scope) {
  const scoped = db.scopeWhere(scope, 'user_id');
  const { results } = await env.DB.prepare(
    `SELECT ${TRAVELLER_COLUMNS} FROM travellers
      WHERE booking_id = ? AND ${scoped.sql}
      ORDER BY is_lead DESC, name ASC`
  ).bind(bookingId, ...scoped.binds).all().catch(() => ({ results: [] }));
  return results || [];
}

export async function listAmenities(env, bookingId, scope) {
  const scoped = db.scopeWhere(scope, 'user_id');
  const { results } = await env.DB.prepare(
    `SELECT id, booking_id, user_id, description, amount_cents, source, status,
            requested_on, notes, created_at
       FROM amenities WHERE booking_id = ? AND ${scoped.sql}
      ORDER BY created_at ASC`
  ).bind(bookingId, ...scoped.binds).all().catch(() => ({ results: [] }));
  return results || [];
}

export async function handleAddTraveller(request, env, bookingId) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const booking = await db.getBooking(env, bookingId, user.id);
  if (!booking) return notFound('Reservation not found.');

  const { fields, error } = parseTraveller(await readJson(request));
  if (error) return badRequest(error);

  // One lead traveller: the vendor's confirmation names one person, and two
  // rows both claiming to be them is worse than none.
  if (fields.isLead) {
    await env.DB.prepare('UPDATE travellers SET is_lead = 0 WHERE booking_id = ?')
      .bind(bookingId).run();
  }

  const id = uid();
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO travellers (id, booking_id, user_id, name, dob, email, phone,
       passport_number, passport_expiry, passport_country, is_lead, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, bookingId, user.id, fields.name, fields.dob, fields.email, fields.phone,
         fields.passportNumber, fields.passportExpiry, fields.passportCountry,
         fields.isLead, fields.notes, ts, ts).run();

  // The traveller count follows the people on the record rather than being
  // typed separately, so the two can never disagree.
  await syncTravellerCount(env, bookingId, user.id);
  return json({ ok: true, id }, 201);
}

export async function handleUpdateTraveller(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const { fields, error } = parseTraveller(await readJson(request));
  if (error) return badRequest(error);

  const existing = await env.DB.prepare(
    'SELECT booking_id FROM travellers WHERE id = ? AND user_id = ?'
  ).bind(id, user.id).first();
  if (!existing) return notFound('Traveller not found.');

  if (fields.isLead) {
    await env.DB.prepare('UPDATE travellers SET is_lead = 0 WHERE booking_id = ?')
      .bind(existing.booking_id).run();
  }

  await env.DB.prepare(
    `UPDATE travellers SET name = ?, dob = ?, email = ?, phone = ?, passport_number = ?,
       passport_expiry = ?, passport_country = ?, is_lead = ?, notes = ?, updated_at = ?
     WHERE id = ? AND user_id = ?`
  ).bind(fields.name, fields.dob, fields.email, fields.phone, fields.passportNumber,
         fields.passportExpiry, fields.passportCountry, fields.isLead, fields.notes,
         now(), id, user.id).run();

  return json({ ok: true });
}

export async function handleDeleteTraveller(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const row = await env.DB.prepare('SELECT booking_id FROM travellers WHERE id = ? AND user_id = ?')
    .bind(id, user.id).first();
  if (!row) return notFound('Traveller not found.');
  await env.DB.prepare('DELETE FROM travellers WHERE id = ? AND user_id = ?').bind(id, user.id).run();
  await syncTravellerCount(env, row.booking_id, user.id);
  return json({ ok: true });
}

async function syncTravellerCount(env, bookingId, userId) {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM travellers WHERE booking_id = ?')
    .bind(bookingId).first().catch(() => null);
  const n = row ? row.n : 0;
  if (!n) return;
  await env.DB.prepare('UPDATE bookings SET travellers = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .bind(n, now(), bookingId, userId).run().catch(() => {});
}

export async function handleAddAmenity(request, env, bookingId) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const booking = await db.getBooking(env, bookingId, user.id);
  if (!booking) return notFound('Reservation not found.');

  const body = await readJson(request);
  const description = clean(body.description, 200);
  if (!description) return badRequest('What is the amenity?');

  const id = uid();
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO amenities (id, booking_id, user_id, description, amount_cents, source,
       status, requested_on, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, bookingId, user.id, description, toCents(body.amount),
         oneOf(body.source, AMENITY_SOURCE), oneOf(body.status, AMENITY_STATUS),
         cleanDate(body.requestedOn), clean(body.notes, 1000), ts, ts).run();

  return json({ ok: true, id }, 201);
}

export async function handleUpdateAmenity(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  // Moving one along is the common case and should not need the whole record.
  if (Object.prototype.hasOwnProperty.call(body, 'status') && Object.keys(body).length === 1) {
    const res = await env.DB.prepare(
      'UPDATE amenities SET status = ?, updated_at = ? WHERE id = ? AND user_id = ?'
    ).bind(oneOf(body.status, AMENITY_STATUS), now(), id, user.id).run();
    if (!res.meta || res.meta.changes === 0) return notFound('Amenity not found.');
    return json({ ok: true });
  }

  const description = clean(body.description, 200);
  if (!description) return badRequest('What is the amenity?');
  const res = await env.DB.prepare(
    `UPDATE amenities SET description = ?, amount_cents = ?, source = ?, status = ?,
       requested_on = ?, notes = ?, updated_at = ? WHERE id = ? AND user_id = ?`
  ).bind(description, toCents(body.amount), oneOf(body.source, AMENITY_SOURCE),
         oneOf(body.status, AMENITY_STATUS), cleanDate(body.requestedOn),
         clean(body.notes, 1000), now(), id, user.id).run();
  if (!res.meta || res.meta.changes === 0) return notFound('Amenity not found.');
  return json({ ok: true });
}

export async function handleDeleteAmenity(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const res = await env.DB.prepare('DELETE FROM amenities WHERE id = ? AND user_id = ?')
    .bind(id, user.id).run();
  if (!res.meta || res.meta.changes === 0) return notFound('Amenity not found.');
  return json({ ok: true });
}
