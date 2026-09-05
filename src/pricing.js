// The parts of a price, and which of them earn commission.
//
// The one idea worth holding on to: a client pays a total, and a vendor pays
// commission on a fraction of it. Cruise fare earns; port taxes, government
// fees and non-commissionable fare do not; gratuities and packages depend on
// the vendor. An agency that does not track the split cannot tell an
// underpayment from a normal one, because every reservation's apparent rate is
// dragged down by money nobody was ever going to pay on.

import { json, badRequest, notFound, clean, oneOf, toCents, uid, now, readJson } from './util.js';
import { requireUser } from './auth.js';
import * as db from './db.js';

// Order is the order they appear on the screen. Whether each earns commission
// by default is the industry norm, not a rule: any line can be flipped.
export const PRICE_KINDS = [
  { kind: 'fare', label: 'Cruise or tour fare', commissionable: true },
  { kind: 'air', label: 'Air', commissionable: false },
  { kind: 'insurance', label: 'Travel insurance', commissionable: true },
  { kind: 'gratuities', label: 'Gratuities', commissionable: false },
  { kind: 'transfers', label: 'Transfers', commissionable: false },
  { kind: 'extra', label: 'Package or extra', commissionable: false },
  { kind: 'ncf', label: 'Non-commissionable fare', commissionable: false },
  { kind: 'taxes', label: 'Taxes and port fees', commissionable: false },
  { kind: 'discount', label: 'Discount or credit', commissionable: false },
];

const KINDS = PRICE_KINDS.map((k) => k.kind);

export async function listPricing(env, bookingId, scope) {
  const scoped = db.scopeWhere(scope, 'user_id');
  const { results } = await env.DB.prepare(
    `SELECT id, booking_id, user_id, kind, label, amount_cents, commissionable,
            commission_cents, sort_order
       FROM booking_pricing WHERE booking_id = ? AND ${scoped.sql}
      ORDER BY sort_order ASC, rowid ASC`
  ).bind(bookingId, ...scoped.binds).all().catch(() => ({ results: [] }));
  return results || [];
}

/**
 * The figures that come out of a breakdown.
 *
 * A discount is stored as a positive amount and subtracted here, because
 * asking anybody to type a negative number into a form is asking for the sign
 * to be wrong half the time.
 */
export function summarise(lines, vendorPct) {
  let clientTotal = 0;
  let commissionable = 0;
  let commission = 0;

  for (const l of lines) {
    const amount = l.amount_cents || 0;
    if (l.kind === 'discount') { clientTotal -= amount; continue; }
    clientTotal += amount;
    if (l.commissionable) commissionable += amount;
    commission += l.commission_cents || 0;
  }

  const expected = vendorPct ? Math.round(commissionable * (vendorPct / 100)) : null;
  return {
    clientTotalCents: clientTotal,
    commissionableCents: commissionable,
    commissionCents: commission,
    expectedCents: expected,
    // The gap worth looking at. A vendor paying less than their own rate on
    // the commissionable part is the thing an agency never notices.
    varianceCents: expected === null ? null : commission - expected,
    // Two rates, because they answer different questions. The effective rate
    // is what the trip earned against what the client paid; the true rate is
    // what the vendor paid against what they pay on.
    effectivePct: clientTotal > 0 ? Math.round((commission / clientTotal) * 1000) / 10 : null,
    truePct: commissionable > 0 ? Math.round((commission / commissionable) * 1000) / 10 : null,
  };
}

function parseLine(body) {
  const kind = oneOf(body.kind, KINDS);
  const amount = toCents(body.amount);
  if (amount < 0) return { error: 'Enter the amount as a positive number.' };
  const commission = toCents(body.commission);
  if (commission > amount && kind !== 'discount') {
    return { error: 'Commission on a line cannot exceed the line itself.' };
  }
  return {
    fields: {
      kind,
      label: clean(body.label, 120),
      amountCents: amount,
      // A discount never earns commission, whatever the box says.
      commissionable: kind === 'discount' ? 0 : (body.commissionable ? 1 : 0),
      commissionCents: commission,
      sortOrder: Math.max(0, Math.min(Number(body.sortOrder) || 0, 999)),
    },
  };
}

export async function handleAddPriceLine(request, env, bookingId) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const booking = await db.getBooking(env, bookingId, user.id);
  if (!booking) return notFound('Reservation not found.');

  const { fields, error } = parseLine(await readJson(request));
  if (error) return badRequest(error);

  const id = uid();
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO booking_pricing (id, booking_id, user_id, kind, label, amount_cents,
       commissionable, commission_cents, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, bookingId, user.id, fields.kind, fields.label, fields.amountCents,
         fields.commissionable, fields.commissionCents, fields.sortOrder, ts, ts).run();

  await syncBookingTotals(env, bookingId, user.id);
  return json({ ok: true, id }, 201);
}

export async function handleUpdatePriceLine(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const row = await env.DB.prepare(
    'SELECT booking_id FROM booking_pricing WHERE id = ? AND user_id = ?'
  ).bind(id, user.id).first();
  if (!row) return notFound('Price line not found.');

  const { fields, error } = parseLine(await readJson(request));
  if (error) return badRequest(error);

  await env.DB.prepare(
    `UPDATE booking_pricing SET kind = ?, label = ?, amount_cents = ?, commissionable = ?,
       commission_cents = ?, sort_order = ?, updated_at = ? WHERE id = ? AND user_id = ?`
  ).bind(fields.kind, fields.label, fields.amountCents, fields.commissionable,
         fields.commissionCents, fields.sortOrder, now(), id, user.id).run();

  await syncBookingTotals(env, row.booking_id, user.id);
  return json({ ok: true });
}

export async function handleDeletePriceLine(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const row = await env.DB.prepare(
    'SELECT booking_id FROM booking_pricing WHERE id = ? AND user_id = ?'
  ).bind(id, user.id).first();
  if (!row) return notFound('Price line not found.');
  await env.DB.prepare('DELETE FROM booking_pricing WHERE id = ? AND user_id = ?')
    .bind(id, user.id).run();
  await syncBookingTotals(env, row.booking_id, user.id);
  return json({ ok: true });
}

/**
 * The reservation's headline totals follow the breakdown once one exists.
 *
 * Every other screen reads gross_cents and commission_cents, and two sets of
 * figures that can disagree eventually will. A reservation with no breakdown
 * keeps whatever was typed, so nothing is lost by never using this.
 */
async function syncBookingTotals(env, bookingId, userId) {
  const lines = await listPricing(env, bookingId, { all: false, userId });
  if (!lines.length) return;
  const s = summarise(lines, null);
  await env.DB.prepare(
    'UPDATE bookings SET gross_cents = ?, commission_cents = ?, updated_at = ? WHERE id = ? AND user_id = ?'
  ).bind(s.clientTotalCents, s.commissionCents, now(), bookingId, userId).run().catch(() => {});
}
