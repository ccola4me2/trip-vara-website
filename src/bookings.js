// Bookings and trips.
//
// This is the one CRM area GoHighLevel cannot model without a pile of custom
// fields: supplier, confirmation number, sail dates, payment deadlines and
// commission. It lives in D1, optionally linked back to the GHL contact and
// opportunity it came from.

import { json, badRequest, notFound, clean, cleanDate, toCents, oneOf, readJson } from './util.js';
import { requireUser } from './auth.js';
import * as db from './db.js';

const PRODUCT_TYPES = ['cruise', 'resort', 'package', 'air', 'other'];
const STATUSES = ['booked', 'quoted', 'travelled', 'cancelled'];
const COMMISSION_STATUSES = ['pending', 'invoiced', 'paid'];

/** Shared parse and validate for create and update. */
function parseBooking(body) {
  const clientName = clean(body.clientName, 120);
  if (!clientName) return { error: 'Client name is required.' };

  const travellers = Math.max(1, Math.min(Number(body.travellers) || 1, 999));
  const departDate = cleanDate(body.departDate);
  const returnDate = cleanDate(body.returnDate);
  if (departDate && returnDate && returnDate < departDate) {
    return { error: 'The return date cannot be before the departure date.' };
  }

  const depositDue = cleanDate(body.depositDue);
  const finalPaymentDue = cleanDate(body.finalPaymentDue);
  if (depositDue && finalPaymentDue && finalPaymentDue < depositDue) {
    return { error: 'Final payment cannot be due before the deposit.' };
  }

  const grossCents = toCents(body.gross);
  const commissionCents = toCents(body.commission);
  if (commissionCents > grossCents && grossCents > 0) {
    return { error: 'Commission cannot exceed the gross booking value.' };
  }

  return {
    fields: {
      ghlContactId: clean(body.ghlContactId, 64) || null,
      ghlOpportunityId: clean(body.ghlOpportunityId, 64) || null,
      clientName,
      supplier: clean(body.supplier, 120),
      productType: oneOf(body.productType, PRODUCT_TYPES),
      productName: clean(body.productName, 160),
      destination: clean(body.destination, 160),
      confirmationNumber: clean(body.confirmationNumber, 80),
      departDate,
      returnDate,
      depositDue,
      finalPaymentDue,
      travellers,
      grossCents,
      commissionCents,
      commissionStatus: oneOf(body.commissionStatus, COMMISSION_STATUSES),
      status: oneOf(body.status, STATUSES),
      notes: clean(body.notes, 4000),
    },
  };
}

export async function handleListBookings(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const url = new URL(request.url);
  const statusParam = url.searchParams.get('status');
  const bookings = await db.listBookings(env, user.id, {
    status: STATUSES.includes(statusParam) ? statusParam : undefined,
    search: clean(url.searchParams.get('q'), 80) || undefined,
    limit: url.searchParams.get('limit'),
  });
  return json({ bookings, stats: await db.bookingStats(env, user.id) });
}

export async function handleGetBooking(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const booking = await db.getBooking(env, id, user.id);
  return booking ? json({ booking }) : notFound('Booking not found.');
}

export async function handleCreateBooking(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const { fields, error } = parseBooking(await readJson(request));
  if (error) return badRequest(error);

  const booking = await db.createBooking(env, user.id, fields);
  await db.logActivity(env, user.id, 'booking.create',
    `Added booking for ${booking.client_name}`, { id: booking.id });
  return json({ ok: true, booking }, 201);
}

export async function handleUpdateBooking(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const { fields, error } = parseBooking(await readJson(request));
  if (error) return badRequest(error);

  const booking = await db.updateBooking(env, id, user.id, fields);
  if (!booking) return notFound('Booking not found.');
  await db.logActivity(env, user.id, 'booking.update',
    `Updated booking for ${booking.client_name}`, { id });
  return json({ ok: true, booking });
}

export async function handleDeleteBooking(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const removed = await db.deleteBooking(env, id, user.id);
  if (!removed) return notFound('Booking not found.');
  await db.logActivity(env, user.id, 'booking.delete', 'Deleted a booking', { id });
  return json({ ok: true });
}
