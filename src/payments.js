// Travel payment schedules: deposits, instalments, final payments.
//
// This is what a travel agency actually tracks. Not "invoicing" in the
// accounting sense, but the schedule a supplier imposes on a booking: a
// deposit to hold it, a balance due by a date, and whether either has landed.

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
    db.paymentStats(env, user.id, { today: isoDay(0), soonThrough: isoDay(30) }),
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
