// Commission the agency is owed, and how long it has been owed.
//
// This is the money the business actually lives on, and until now the portal
// held it as a single field on a reservation with three possible values and no
// way to see the whole picture. The questions an owner asks are: who owes us,
// how much, and how long has it been. None of them could be answered.
//
// Commission becomes claimable when the client travels, not when they book, so
// ageing runs from the return date. A trip that has not departed is not late,
// however long ago it was sold, and mixing the two makes everything look
// overdue and the report worth ignoring.

import { json, badRequest, oneOf, now, readJson } from './util.js';
import { requireUser } from './auth.js';
import * as db from './db.js';

const STATUSES = ['pending', 'invoiced', 'paid'];

function isoDay(offsetDays = 0) {
  return new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
}

/** Which ageing bucket a returned trip falls into. */
function bucketFor(daysSince) {
  if (daysSince === null) return 'travelling';
  if (daysSince < 0) return 'travelling';
  if (daysSince <= 30) return 'd30';
  if (daysSince <= 60) return 'd60';
  if (daysSince <= 90) return 'd90';
  return 'older';
}

export const BUCKETS = [
  { key: 'travelling', label: 'Not yet travelled', hint: 'Nothing to claim until they are back' },
  { key: 'd30', label: 'Up to 30 days', hint: 'Normal vendor turnaround' },
  { key: 'd60', label: '31 to 60 days', hint: 'Worth a look' },
  { key: 'd90', label: '61 to 90 days', hint: 'Chase the vendor' },
  { key: 'older', label: 'Over 90 days', hint: 'Money that may quietly never arrive' },
];

export async function handleListCommissions(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const url = new URL(request.url);
  const status = STATUSES.includes(url.searchParams.get('status'))
    ? url.searchParams.get('status') : null;
  const scope = db.scopeFor(env, user, request);
  const scoped = db.scopeWhere(scope, 'b.user_id');
  const today = isoDay(0);

  const where = [scoped.sql, "b.status IN ('booked','travelled')", 'b.commission_cents > 0'];
  const binds = [...scoped.binds];
  if (status) { where.push('b.commission_status = ?'); binds.push(status); }

  const { results } = await env.DB.prepare(
    `SELECT b.id, b.client_name, b.supplier, b.product_name, b.depart_date, b.return_date,
            b.gross_cents, b.commission_cents, b.commission_status, b.confirmation_number,
            b.user_id,
            COALESCE(NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), ''), u.email)
              AS advisor_name
       FROM bookings b LEFT JOIN users u ON u.id = b.user_id
      WHERE ${where.join(' AND ')}
      ORDER BY COALESCE(b.return_date, b.depart_date, '9999-12-31') ASC
      LIMIT 500`
  ).bind(...binds).all();

  const rows = (results || []).map((r) => {
    const back = r.return_date || r.depart_date;
    const daysSince = back
      ? Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${back}T00:00:00Z`)) / 86400000)
      : null;
    return { ...r, back, daysSince, bucket: bucketFor(daysSince) };
  });

  // Only unpaid commission ages. Once it has arrived, how long it took is
  // history rather than a thing to act on.
  const owed = rows.filter((r) => r.commission_status !== 'paid');
  const ageing = Object.fromEntries(BUCKETS.map((b) => [b.key, { cents: 0, count: 0 }]));
  for (const r of owed) {
    ageing[r.bucket].cents += r.commission_cents || 0;
    ageing[r.bucket].count += 1;
  }

  const byVendor = {};
  for (const r of owed) {
    const key = r.supplier || 'Unrecorded vendor';
    byVendor[key] = byVendor[key] || { vendor: key, cents: 0, count: 0, oldestDays: null };
    byVendor[key].cents += r.commission_cents || 0;
    byVendor[key].count += 1;
    if (r.daysSince !== null && r.daysSince > (byVendor[key].oldestDays ?? -1)) {
      byVendor[key].oldestDays = r.daysSince;
    }
  }

  return json({
    rows,
    buckets: BUCKETS,
    ageing,
    byVendor: Object.values(byVendor).sort((a, b) => b.cents - a.cents),
    totals: {
      owedCents: owed.reduce((n, r) => n + (r.commission_cents || 0), 0),
      owedCount: owed.length,
      // Claimable means they are home and it has not been paid: the number to
      // act on, as opposed to everything that will eventually be due.
      claimableCents: owed.filter((r) => r.bucket !== 'travelling')
        .reduce((n, r) => n + (r.commission_cents || 0), 0),
      paidCents: rows.filter((r) => r.commission_status === 'paid')
        .reduce((n, r) => n + (r.commission_cents || 0), 0),
      lateCents: owed.filter((r) => r.bucket === 'older')
        .reduce((n, r) => n + (r.commission_cents || 0), 0),
    },
    today,
    scope: db.scopeLabel(scope, user),
    advisors: await db.advisorOptions(env, user),
  });
}

/**
 * Move several reservations along at once.
 *
 * Commission is invoiced and chased in batches, one vendor statement at a
 * time, so doing it one reservation at a time is the kind of friction that
 * ends with nobody doing it at all. Scoped to the caller's own reservations:
 * an owner may read an associate's commission but not declare it paid.
 */
export async function handleSetCommissionStatus(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const status = oneOf(body.status, STATUSES);
  if (!STATUSES.includes(String(body.status || ''))) {
    return badRequest('Pick pending, invoiced or paid.');
  }

  const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === 'string').slice(0, 200) : [];
  if (!ids.length) return badRequest('Nothing was selected.');

  const marks = ids.map(() => '?').join(',');
  const res = await env.DB.prepare(
    `UPDATE bookings SET commission_status = ?, updated_at = ?
      WHERE user_id = ? AND id IN (${marks})`
  ).bind(status, now(), user.id, ...ids).run();

  const changed = res.meta ? res.meta.changes || 0 : 0;
  await db.logActivity(env, user.id, 'commission.status',
    `Marked ${changed} reservation${changed === 1 ? '' : 's'} ${status}`, { status, count: changed });

  // Says how many actually moved rather than how many were asked for, so
  // selecting somebody else's reservation is visible rather than silent.
  return json({ ok: true, status, requested: ids.length, changed });
}
