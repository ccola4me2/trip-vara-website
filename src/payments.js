// Client payments to travel suppliers.
//
// The agency never handles this money. A client pays the cruise line or resort
// directly; the advisor posts and tracks those payments so nothing slips past
// a supplier deadline and cancels a booking. "Deposit" is the amount a client
// pays up front to hold a trip, not a bank deposit.
//
// The agency's own revenue is the commission a supplier pays it, which lives
// on the booking and is deliberately kept out of these totals. Mixing the two
// would make it look like the agency turned over the full trip cost.

import { json, badRequest, notFound, uid, now, clean, cleanDate, toCents, oneOf, readJson } from './util.js';
import { requireUser } from './auth.js';
import * as db from './db.js';
import * as ghl from './ghl.js';

const KINDS = ['deposit', 'installment', 'final', 'refund'];
const METHODS = ['card', 'ach', 'check', 'cash', 'transfer', 'other'];

const isoDay = (offsetDays = 0) =>
  new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);

export async function handlePayments(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const url = new URL(request.url);
  const state = oneOf(url.searchParams.get('state') || 'all', ['all', 'outstanding', 'paid']);

  const [payments, stats, balances] = await Promise.all([
    db.listPayments(env, user.id, { state: state === 'all' ? undefined : state }),
    db.paymentStats(env, user.id, {
      today: isoDay(0), soonThrough: isoDay(30), urgentThrough: isoDay(14),
    }),
    db.bookingBalances(env, user.id),
  ]);

  return json({
    payments,
    stats,
    balances: balances.map((b) => ({
      ...b,
      // What is neither paid nor even scheduled yet. A booking worth $8,000
      // with a $500 deposit and nothing else on the schedule is the common
      // case that quietly goes uncollected.
      unscheduled_cents: Math.max(0, (b.gross_cents || 0) - (b.paid_cents || 0) - (b.scheduled_cents || 0)),
    })),
    today: isoDay(0),
  });
}

function parsePayment(body) {
  const bookingId = clean(body.bookingId, 64);
  if (!bookingId) return { error: 'Pick a booking.' };

  const amountCents = toCents(body.amount);
  if (amountCents <= 0) return { error: 'Enter an amount.' };

  const dueDate = cleanDate(body.dueDate);
  const paidDate = cleanDate(body.paidDate);
  if (!dueDate && !paidDate) {
    return { error: 'A payment needs a due date, a paid date, or both.' };
  }

  return {
    fields: {
      bookingId,
      kind: oneOf(body.kind, KINDS),
      amountCents,
      dueDate,
      paidDate,
      method: paidDate ? oneOf(body.method, METHODS) : null,
      reference: clean(body.reference, 80),
      notes: clean(body.notes, 500),
    },
  };
}

export async function handleCreatePayment(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const { fields, error } = parsePayment(await readJson(request));
  if (error) return badRequest(error);

  // The booking has to be this advisor's, or one advisor could attach a
  // payment to another's booking.
  const booking = await db.getBooking(env, fields.bookingId, user.id);
  if (!booking) return notFound('Booking not found.');

  const payment = await db.createPayment(env, user.id, fields);
  await db.logActivity(env, user.id, 'payment.create',
    `${fields.paidDate ? 'Recorded' : 'Scheduled'} ${fields.kind} for ${booking.client_name}`,
    { bookingId: fields.bookingId });
  return json({ ok: true, payment }, 201);
}

export async function handleUpdatePayment(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const { fields, error } = parsePayment(await readJson(request));
  if (error) return badRequest(error);

  // The payment itself is scoped by user, but the booking it points at comes
  // from the request. Without this an advisor could move their own payment
  // onto someone else's booking and corrupt that booking's balance. Create
  // already checked this; update did not.
  const booking = await db.getBooking(env, fields.bookingId, user.id);
  if (!booking) return notFound('Booking not found.');

  const payment = await db.updatePayment(env, id, user.id, fields);
  if (!payment) return notFound('Payment not found.');
  await db.logActivity(env, user.id, 'payment.update', 'Updated a payment', { id });
  return json({ ok: true, payment });
}

/** The one-click action: this money arrived today. */
export async function handleMarkPaid(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const existing = await db.getPayment(env, id, user.id);
  if (!existing) return notFound('Payment not found.');

  const payment = await db.updatePayment(env, id, user.id, {
    kind: existing.kind,
    amountCents: existing.amount_cents,
    dueDate: existing.due_date,
    paidDate: cleanDate(body.paidDate) || isoDay(0),
    method: oneOf(body.method, METHODS),
    reference: clean(body.reference, 80) || existing.reference,
    notes: existing.notes,
  });
  await db.logActivity(env, user.id, 'payment.paid', 'Marked a payment received', { id });
  return json({ ok: true, payment });
}

export async function handleDeletePayment(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const removed = await db.deletePayment(env, id, user.id);
  if (!removed) return notFound('Payment not found.');
  await db.logActivity(env, user.id, 'payment.delete', 'Removed a payment', { id });
  return json({ ok: true });
}

/**
 * Builds a schedule from what the booking already knows.
 *
 * Most bookings follow the same shape: a deposit to hold it, then the balance
 * by a supplier deadline. Generating that rather than making someone type it
 * twice is the difference between the schedule being kept up and being
 * ignored. Skips anything already scheduled so it is safe to run twice.
 */
export async function handleGenerateSchedule(request, env, bookingId) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const booking = await db.getBooking(env, bookingId, user.id);
  if (!booking) return notFound('Booking not found.');

  const existing = await db.listPayments(env, user.id, { bookingId });
  const have = new Set(existing.map((p) => p.kind));
  const created = [];

  if (booking.deposit_cents > 0 && booking.deposit_due && !have.has('deposit')) {
    created.push(await db.createPayment(env, user.id, {
      bookingId, kind: 'deposit', amountCents: booking.deposit_cents,
      dueDate: booking.deposit_due, paidDate: null,
      notes: 'Generated from the booking',
    }));
  }

  const balance = (booking.gross_cents || 0) - (booking.deposit_cents || 0);
  if (balance > 0 && booking.final_payment_due && !have.has('final')) {
    created.push(await db.createPayment(env, user.id, {
      bookingId, kind: 'final', amountCents: balance,
      dueDate: booking.final_payment_due, paidDate: null,
      notes: 'Generated from the booking',
    }));
  }

  if (!created.length) {
    return json({
      ok: true, created: [],
      message: have.size
        ? 'This booking already has a schedule.'
        : 'Add a deposit amount and payment dates to the booking first.',
    });
  }

  await db.logActivity(env, user.id, 'payment.schedule',
    `Built a payment schedule for ${booking.client_name}`, { bookingId });
  return json({ ok: true, created }, 201);
}


/**
 * Set a booking's status.
 *
 * Exists because of what happens when a final payment date passes unpaid: the
 * supplier cancels the booking. The portal cannot know that happened, so the
 * payments page offers the advisor a way to record it once they have checked,
 * rather than leaving a dead booking counted as live revenue forever.
 */
export async function handleSetBookingStatus(request, env, bookingId) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const status = oneOf(body.status, ['booked', 'quoted', 'travelled', 'cancelled']);

  const booking = await db.getBooking(env, bookingId, user.id);
  if (!booking) return notFound('Booking not found.');

  const updated = await db.updateBooking(env, bookingId, user.id, {
    ghlContactId: booking.ghl_contact_id,
    ghlOpportunityId: booking.ghl_opportunity_id,
    clientName: booking.client_name,
    supplier: booking.supplier,
    productType: booking.product_type,
    productName: booking.product_name,
    destination: booking.destination,
    confirmationNumber: booking.confirmation_number,
    departDate: booking.depart_date,
    returnDate: booking.return_date,
    depositDue: booking.deposit_due,
    finalPaymentDue: booking.final_payment_due,
    travellers: booking.travellers,
    grossCents: booking.gross_cents,
    depositCents: booking.deposit_cents,
    commissionCents: booking.commission_cents,
    commissionStatus: booking.commission_status,
    status,
    notes: booking.notes,
  });

  await db.logActivity(env, user.id, 'booking.status',
    `Marked ${booking.client_name} ${status}`, { bookingId, status });
  return json({ ok: true, booking: updated });
}
