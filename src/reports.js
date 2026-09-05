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

  const today = isoDay(0);

  const scope = db.scopeFor(env, user, request);

  const [stats, payStats, payments, activity, recentAdded, recentModified,
         upcoming, traveling, returned] = await Promise.all([
    db.bookingStats(env, scope),
    db.paymentStats(env, scope, { today, soonThrough: isoDay(60) }),
    db.upcomingPayments(env, scope, isoDay(60)),
    db.recentActivity(env, scope, 8),
    db.recentReservations(env, scope, { by: 'added' }),
    db.recentReservations(env, scope, { by: 'modified' }),
    db.currentReservations(env, scope, { view: 'upcoming', today }),
    db.currentReservations(env, scope, { view: 'traveling', today }),
    db.currentReservations(env, scope, { view: 'returned', today }),
  ]);

  // Live pipeline, best effort. A CRM outage should cost one widget, not the
  // whole dashboard.
  let pipeline = null;
  let ghlStatus = 'ok';
  if (!ghl.ghlConfigured(env)) {
    ghlStatus = 'not_configured';
  } else {
    try {
      const locationId = ghl.locationFor(env, user);
      const pipelines = await db.localPipelines(env, locationId);
      if (pipelines.length) {
        const first = pipelines[0];
        const opps = await db.localOpportunities(env, locationId, {
          pipelineId: first.id, status: 'open',
        });
        // Grouped by stage, the way Sales Opportunities reads in CP Maxx.
        const byStage = first.stages.map((st) => {
          const items = opps.filter((o) => o.stageId === st.id);
          return { name: st.name, count: items.length,
                   value: items.reduce((n, o) => n + o.monetaryValue, 0) };
        }).filter((st) => st.count > 0);
        pipeline = {
          name: first.name,
          openCount: opps.length,
          openValue: opps.reduce((n, o) => n + o.monetaryValue, 0),
          stages: byStage,
        };
      } else {
        pipeline = { name: null, openCount: 0, openValue: 0, stages: [] };
      }
    } catch (e) {
      ghlStatus = 'error';
      console.error('dashboard pipeline', e);
    }
  }

  return json({
    user: { name: [user.first_name, user.last_name].filter(Boolean).join(' ') || user.email },
    stats,
    payStats,
    upcomingPayments: payments,
    activity,
    reservations: { added: recentAdded, modified: recentModified },
    current: { upcoming, traveling, returned },
    pipeline,
    ghlStatus,
    today,
    scope: db.scopeLabel(scope, user),
    advisors: await db.advisorOptions(env, user),
  });
}

export async function handleProduction(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const url = new URL(request.url);
  const months = Math.min(Math.max(Number(url.searchParams.get('months')) || 12, 1), 36);
  const since = isoDay(-months * 31);

  const scope = db.scopeFor(env, user, request);

  const [byMonth, stats, cashflow, payStats, byAdvisor] = await Promise.all([
    db.productionByMonth(env, scope, since),
    db.bookingStats(env, scope),
    db.paymentsByMonth(env, scope, since),
    db.paymentStats(env, scope, { today: isoDay(0), soonThrough: isoDay(30), urgentThrough: isoDay(14) }),
    // An owner's combined report is only useful if it breaks down. An advisor
    // sees a one row version of this, which is their own line.
    db.productionByAdvisor(env, scope, since),
  ]);

  // Collection rate: of everything that has already fallen due, how much has
  // actually been posted. A low number here is the early warning that a
  // booking is about to be cancelled by its supplier.
  const dueSoFar = (payStats.postedCents || 0) + (payStats.pastDueCents || 0);
  const collectionRate = dueSoFar > 0
    ? Math.round((payStats.postedCents / dueSoFar) * 1000) / 10
    : null;

  return json({
    months, since, byMonth, stats, cashflow, payments: payStats, collectionRate,
    byAdvisor,
    scope: db.scopeLabel(scope, user),
    advisors: await db.advisorOptions(env, user),
  });
}
