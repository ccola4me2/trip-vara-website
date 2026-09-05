// Dashboard and reporting.
//
// Pulls the D1 booking numbers and, when GoHighLevel is connected, a live
// pipeline snapshot. A GHL outage degrades to booking-only numbers rather than
// failing the whole dashboard, because the D1 half is still useful on its own.

import { json } from './util.js';
import { requireUser } from './auth.js';
import * as db from './db.js';
import * as ghl from './ghl.js';

function isoDay(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return d.toISOString().slice(0, 10);
}

export async function handleDashboard(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const [stats, payments, activity] = await Promise.all([
    db.bookingStats(env, user.id),
    db.upcomingPayments(env, user.id, isoDay(60)),
    db.recentActivity(env, user.id, 12),
  ]);

  // Live pipeline snapshot, best effort.
  let pipeline = null;
  let ghlStatus = 'ok';
  if (!ghl.ghlConfigured(env)) {
    ghlStatus = 'not_configured';
  } else {
    try {
      const locationId = ghl.locationFor(env, user);
      const pipelines = await ghl.listPipelines(env, locationId);
      if (pipelines.length) {
        const first = pipelines[0];
        const { opportunities } = await ghl.searchOpportunities(env, locationId, {
          pipelineId: first.id, status: 'open', limit: 100,
        });
        pipeline = {
          name: first.name,
          openCount: opportunities.length,
          openValue: opportunities.reduce((sum, o) => sum + o.monetaryValue, 0),
        };
      } else {
        pipeline = { name: null, openCount: 0, openValue: 0 };
      }
    } catch (e) {
      ghlStatus = 'error';
      console.error('dashboard pipeline', e);
    }
  }

  return json({
    user: { name: [user.first_name, user.last_name].filter(Boolean).join(' ') || user.email },
    stats,
    upcomingPayments: payments,
    activity,
    pipeline,
    ghlStatus,
  });
}

export async function handleProduction(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const url = new URL(request.url);
  const months = Math.min(Math.max(Number(url.searchParams.get('months')) || 12, 1), 36);
  const since = isoDay(-months * 31);

  const [byMonth, stats, cashflow, payStats] = await Promise.all([
    db.productionByMonth(env, user.id, since),
    db.bookingStats(env, user.id),
    db.paymentsByMonth(env, user.id, since),
    db.paymentStats(env, user.id, { today: isoDay(0), soonThrough: isoDay(30), urgentThrough: isoDay(14) }),
  ]);

  // Collection rate: of everything that has already fallen due, how much has
  // actually been posted. A low number here is the early warning that a
  // booking is about to be cancelled by its supplier.
  const dueSoFar = (payStats.postedCents || 0) + (payStats.pastDueCents || 0);
  const collectionRate = dueSoFar > 0
    ? Math.round((payStats.postedCents / dueSoFar) * 1000) / 10
    : null;

  return json({ months, since, byMonth, stats, cashflow, payments: payStats, collectionRate });
}
