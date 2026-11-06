// What the Group Desk may ask this portal, and nothing else.
//
// The desk runs on the other portal. Its members are in an agency of their own
// there, so the agency fence keeps every client, reservation and dollar of
// either portal away from them, which is the arrangement and it stays.
//
// The cost of that fence is that a Margaritaville cabin an advisor books here
// has to be retyped onto the group's sheet over there. This answers the one
// question that closes the gap: for these desk addresses, what Margaritaville
// at Sea reservations do they have, and what is each one made of.
//
// Three rules shape it.
//
//   It is already described. The desk is handed a cabin, a category, guest
//   names, a booking number and two figures, not rows from this schema. The
//   other portal never learns how this one stores anything, so a column renamed
//   here cannot break a sheet there.
//
//   It never carries commission. The desk's own page promises a sheet shows
//   "never any commission", and the way to keep a promise like that is to not
//   send the number in the first place.
//
//   It fails closed. Every other guard in this portal fails open, because a
//   missing Turnstile key should not stop a real customer signing up. This one
//   hands over a client's name, cabin and money, so with no shared secret
//   configured it answers nobody, including the desk.

import { json, badRequest, clean, cleanText, normalizeEmail, readJson } from './util.js';
import { listPricing, clientLines } from './pricing.js';
import * as db from './db.js';

// Reservations with this anywhere in the supplier or the product.
const MAS = '%margaritaville%';

// How many addresses one call may ask about. The desk has three members and
// is never going to have three hundred; a cap means a malformed call costs one
// query rather than the database.
const MAX_EMAILS = 25;

/**
 * Is this really the other Worker?
 *
 * Service bindings are private, but the same path is also served on this
 * portal's own hostname, so the binding is not the guard. The shared secret is.
 * Compared in full rather than byte by byte with an early exit, which is the
 * cheap way to leak its length.
 */
function peerAllowed(env, request) {
  const want = String(env.PEER_SECRET || '');
  if (want.length < 20) return false;
  const got = String(request.headers.get('X-Peer-Secret') || '');
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i += 1) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

/** Everything the sheet shows for one reservation, and not one field more. */
async function describe(env, userId, b) {
  const scope = { all: false, userId, self: true };

  const { results: people } = await env.DB.prepare(
    'SELECT name FROM travellers WHERE booking_id = ? AND user_id = ? ORDER BY is_lead DESC, name ASC'
  ).bind(b.id, userId).all().catch(() => ({ results: [] }));
  const names = (people || []).map((p) => p.name).filter(Boolean);

  // Held, part paid or paid, counted the way the desk counts it: by how many
  // of the hard payments have a paid date, not by the money.
  const pay = await env.DB.prepare(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN paid_date IS NOT NULL THEN 1 ELSE 0 END) AS paid
       FROM booking_payments WHERE booking_id = ? AND user_id = ? AND payment_class = 'hard'`
  ).bind(b.id, userId).first().catch(() => null);
  const total = (pay && pay.total) || 0;
  const paid = (pay && pay.paid) || 0;

  // What the client is told the trip costs: the breakdown when there is one,
  // otherwise the total on the reservation.
  const lines = clientLines(await listPricing(env, b.id, scope).catch(() => []));
  const broken = lines.reduce((n, l) => n + (l.deduct ? -l.amountCents : l.amountCents), 0);
  const tripCents = Math.max(0, lines.length ? broken : (Number(b.gross_cents) || 0));

  const arrived = await env.DB.prepare(
    `SELECT COALESCE(SUM(amount_cents), 0) AS cents FROM booking_payments
      WHERE booking_id = ? AND user_id = ? AND payment_class = 'hard' AND paid_date IS NOT NULL
        AND kind <> 'refund' AND amount_cents > 0`
  ).bind(b.id, userId).first().catch(() => null);

  let status = 'held';
  if (b.status === 'cancelled') status = 'cancelled';
  else if (total > 0 && paid >= total) status = 'paid';
  else if (paid > 0) status = 'deposit';

  return {
    id: b.id,
    cabinNo: clean(b.cabin, 20),
    category: clean(b.cabin_category, 60),
    guests: Math.max(1, Math.min(names.length || Number(b.travellers) || 1, 12)),
    guestNames: cleanText(names.length ? names.join(', ') : b.client_name, 600),
    bookingNo: clean(b.confirmation_number, 40),
    status,
    totalCents: tripCents,
    paidCents: Number(arrived && arrived.cents) || 0,
    departDate: b.depart_date || null,
    groupNumber: clean(b.group_number, 40),
  };
}

/**
 * POST /api/peer/mas-bookings
 *
 * In: { emails: [desk sign in address, ...] }
 * Out: { people: [{ email, name, bookings: [described, ...] }] }
 *
 * An address nobody here claims comes back as no person rather than an error,
 * so the desk can ask about all of its members every time without knowing
 * which of them has an account on this portal.
 */
export async function handlePeerMasBookings(request, env) {
  if (!peerAllowed(env, request)) return json({ error: 'Not for you.' }, 403);

  const body = await request.json().catch(() => ({}));
  const asked = Array.isArray(body.emails) ? body.emails : [];
  const emails = [...new Set(asked.map((e) => normalizeEmail(String(e || ''))).filter(Boolean))]
    .slice(0, MAX_EMAILS);
  if (!emails.length) return json({ people: [] });

  // Matched on the sign in address and nothing else. A desk member and the
  // advisor here are the same person when they are the same address, which is
  // what an email already means everywhere else in both portals. No column to
  // keep in step, and nothing for anybody to remember to link.
  const holes = emails.map(() => '?').join(', ');
  const { results: users } = await env.DB.prepare(
    `SELECT id, email, first_name, last_name FROM users
      WHERE LOWER(email) IN (${holes}) AND status = 'active'`
  ).bind(...emails).all().catch(() => ({ results: [] }));

  const people = [];
  for (const u of users || []) {
    const { results: rows } = await env.DB.prepare(
      `SELECT id, client_name, cabin, cabin_category, confirmation_number, travellers, status,
              depart_date, group_number, gross_cents
         FROM bookings
        WHERE user_id = ? AND status IN ('booked', 'travelled')
          AND (LOWER(supplier) LIKE ? OR LOWER(product_name) LIKE ?)
        ORDER BY depart_date ASC LIMIT 200`
    ).bind(u.id, MAS, MAS).all().catch(() => ({ results: [] }));

    const bookings = [];
    for (const b of rows || []) bookings.push(await describe(env, u.id, b));
    people.push({
      email: u.email,
      name: `${u.first_name || ''} ${u.last_name || ''}`.trim(),
      bookings,
    });
  }
  return json({ people });
}

/**
 * POST /api/peer/mas-reservation
 *
 * The other direction: a cabin that exists only on a group's sheet, written
 * into the advisor's own book here.
 *
 * Somebody uploads the cruise line's agent copy onto a sheet and the cabin
 * appears there with the guests, the booking number and the money on it. None
 * of that reaches this portal, so the same booking has to be typed in again to
 * be tracked, chased and paid on. This takes it across once.
 *
 * It creates and it never changes. A booking number already on this advisor's
 * books comes back as the one that is there rather than a second copy of it,
 * so pressing the button twice, or a retry after a timeout, cannot split one
 * cabin into two reservations. Nothing here can edit, reprice or cancel a
 * reservation: the desk may put a booking into somebody's book and that is the
 * whole of its reach.
 *
 * What it does not invent: no payment schedule, no deposit, no commission. A
 * sheet knows what has been paid in total but not when, how, or against which
 * instalment, and a money record guessed from that is worse than one the
 * advisor enters. The trip total is a fact and is carried.
 */
export async function handlePeerMasReservation(request, env) {
  if (!peerAllowed(env, request)) return json({ error: 'Not for you.' }, 403);

  const body = await readJson(request).catch(() => ({}));
  const email = normalizeEmail(clean(body.email, 254));
  if (!email) return badRequest('Which advisor this is for.');

  // Whose book, decided here and never by the caller. The desk sends the
  // address of the person who pressed the button, so the only book reachable
  // is that person's own.
  const user = await env.DB.prepare(
    "SELECT id FROM users WHERE LOWER(email) = ? AND status = 'active'"
  ).bind(email).first().catch(() => null);
  if (!user) return json({ error: 'Nobody here signs in with that address.' }, 404);

  const confirmationNumber = clean(body.bookingNo, 40);
  if (!confirmationNumber) {
    return badRequest('A booking number, so this cannot be taken across twice.');
  }

  const already = await env.DB.prepare(
    'SELECT id FROM bookings WHERE user_id = ? AND confirmation_number = ?'
  ).bind(user.id, confirmationNumber).first().catch(() => null);
  if (already) return json({ ok: true, id: already.id, created: false });

  const clientName = clean(body.clientName, 120)
    || clean(String(body.guestNames || '').split(',')[0], 120);
  if (!clientName) return badRequest('A name for the client.');

  const clientId = await db.resolveClient(env, user.id, clientName);

  const booking = await db.createBooking(env, user.id, {
    clientName,
    clientId,
    supplier: 'Margaritaville at Sea',
    productType: 'cruise',
    productName: clean(body.productName, 160) || 'Margaritaville at Sea',
    confirmationNumber,
    groupNumber: clean(body.groupNumber, 40),
    departDate: clean(body.departDate, 10) || null,
    returnDate: clean(body.returnDate, 10) || null,
    cabin: clean(body.cabinNo, 20),
    cabinCategory: clean(body.category, 60),
    travellers: Math.max(1, Math.min(Number(body.guests) || 1, 12)),
    grossCents: Math.max(0, Math.trunc(Number(body.totalCents) || 0)),
    status: 'booked',
    notes: cleanText(body.notes, 400),
    // createBooking binds every column, and D1 refuses undefined outright, so
    // the fields a sheet has no answer for are spelled out as null rather than
    // left off. The money ones are deliberate blanks, not oversights: see the
    // note above on what this does not invent.
    destination: null,
    depositDue: null,
    finalPaymentDue: null,
    depositCents: 0,
    // Not null in the schema, so a blank here is a zero and a pending, which
    // is exactly what an advisor who has not worked the commission out yet has.
    commissionCents: 0,
    commissionStatus: 'pending',
    depositRefundable: null,
  });

  await db.logActivity(env, user.id, 'booking.create',
    `Took a cabin across from the group desk: ${confirmationNumber}`,
    { id: booking?.id, desk: true });

  return json({ ok: true, id: booking?.id, created: true }, 201);
}
