// Admin: approve advisor accounts, bind them to a GoHighLevel sub-account,
// and suspend access.

import {
  json, badRequest, notFound, clean, cleanText, readJson,
  normalizeEmail, isValidEmail,
} from './util.js';
import { tenantFor } from './tenant.js';
import { requireAdmin, publicUser } from './auth.js';
import * as db from './db.js';
import { sendAdvisorApprovedEmail, checkResend, sendTestEmail } from './email.js';
import { remindTasks } from './taskmail.js';
import { remindDuePayments } from './payremind.js';
import { sendCallLists } from './calllist.js';
import { schemaDrift } from './schema-drift.js';
import { jobHealth } from './cronlog.js';
import { mirrorCatalogStep, mirrorStatus } from './catalogmirror.js';

const STATUSES = ['pending', 'active', 'suspended'];

/**
 * Whether this owner may act on this advisor.
 *
 * The three handlers below took a user id and checked only that the caller was
 * an owner, which with one agency meant "an owner of the only agency there is".
 * With two it meant one agency could suspend another's staff.
 */
async function reachable(env, admin, userId) {
  const target = await db.getUserById(env, userId);
  if (!target) return { error: notFound('Advisor not found.') };
  if (admin.platform_owner) return { target };
  if (!admin.agency_id || target.agency_id !== admin.agency_id) {
    // The same answer as a user who does not exist. Telling one agency that an
    // address belongs to somebody at another is itself the leak.
    return { error: notFound('Advisor not found.') };
  }
  return { target };
}

export async function handleListAdvisors(request, env) {
  const { user: admin, response } = await requireAdmin(request, env);
  if (response) return response;

  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  // Their own agency, unless they run the portal. Unfiltered, this handed
  // every owner the name, email and phone of every advisor on the platform.
  const agencyId = admin.platform_owner ? undefined : (admin.agency_id || '__none__');
  const users = await db.listUsers(env, {
    status: STATUSES.includes(status) ? status : undefined,
    agencyId,
  });
  return json({
    users: users.map(publicUser),
    counts: await db.countUsers(env, { agencyId }),
    platformOwner: Boolean(admin.platform_owner),
    agencies: admin.platform_owner ? await agencyNames(env) : [],
  });
}

/** Agency names for the platform owner's advisor list, so a row says whose. */
async function agencyNames(env) {
  const { results } = await env.DB.prepare(
    'SELECT id, name FROM agencies ORDER BY name ASC LIMIT 200'
  ).all().catch(() => ({ results: [] }));
  return results || [];
}

/**
 * How one reservation's commission divides.
 *
 * Its own endpoint rather than a guard on the advisor's, because the advisor's
 * is scoped to whoever is signed in: an admin cannot reach somebody else's
 * booking through it at all. Guarding it there would leave this settable by
 * nobody.
 *
 * Reached by user rather than by booking: the fence is which agency the
 * advisor who owns it belongs to, which is the question reachable() already
 * answers everywhere else in this file.
 */
/**
 * The advisor's own details, edited by somebody who is not them.
 *
 * Every field here ends up in front of a client: the name on a quote, the
 * phone at the bottom of an email, the registration number a state requires on
 * the document. A typo in one is a typo a client reads, and the only way to
 * fix one used to be to sign in as the advisor and do it from their side.
 *
 * Deliberately not the notification switches. Those are the advisor's own
 * choices about how the portal talks to them, and an admin silently turning
 * off somebody's morning email is not a profile edit.
 */
export async function handleUpdateAdvisor(request, env, userId) {
  const { user: admin, response } = await requireAdmin(request, env);
  if (response) return response;
  const reach = await reachable(env, admin, userId);
  if (reach.error) return reach.error;
  const before = reach.target;

  const body = await readJson(request);
  const firstName = clean(body.firstName, 80);
  const lastName = clean(body.lastName, 80);
  if (!firstName || !lastName) return badRequest('First and last name are required.');

  // The address they sign in with. Optional to send: a caller that does not
  // mention it leaves it alone, which is the rule everywhere else in this
  // portal and the reason a save from one screen cannot undo another.
  let email = before.email;
  if (body.email !== undefined) {
    email = normalizeEmail(body.email);
    if (!isValidEmail(email)) return badRequest('Enter a valid email address.');
    if (email !== before.email && await db.emailExists(env, email)) {
      return badRequest('There is already an account with that email address.');
    }
  }

  const updated = await db.updateUserProfile(env, userId, {
    firstName,
    lastName,
    phone: clean(body.phone, 40),
    notifyEmail: clean(body.notifyEmail, 254),
    agencyName: clean(body.agencyName, 160),
    agencyAddress: cleanText(body.agencyAddress, 400),
    sellerOfTravel: clean(body.sellerOfTravel, 120),
  });
  if (!updated) return notFound('Advisor not found.');

  if (email !== before.email) {
    await db.setUserEmail(env, userId, email);
  }

  // What changed, by name. "Updated the advisor" is a line nobody can audit;
  // this one says which field and from what, which is the only version worth
  // keeping.
  const changed = [];
  const say = (label, was, now) => {
    if ((was || '') !== (now || '')) changed.push(`${label} ${was || 'blank'} to ${now || 'blank'}`);
  };
  say('name', [before.first_name, before.last_name].filter(Boolean).join(' '),
      [firstName, lastName].filter(Boolean).join(' '));
  say('email', before.email, email);
  say('phone', before.phone, clean(body.phone, 40));
  say('agency name', before.agency_name, clean(body.agencyName, 160));
  say('seller of travel', before.seller_of_travel, clean(body.sellerOfTravel, 120));

  if (changed.length) {
    await db.logActivity(env, admin.id, 'admin.advisor.edit',
      `Changed ${before.email}: ${changed.join('; ')}`, { userId, fields: changed.length });
  }

  const after = await db.getUserById(env, userId);
  return json({ ok: true, user: publicUser(after), changed });
}

export async function handleSetBookingSplit(request, env, bookingId) {
  const { user: admin, response } = await requireAdmin(request, env);
  if (response) return response;

  const booking = await db.getBookingUnscoped(env, bookingId);
  if (!booking) return notFound('Reservation not found.');
  const reach = await reachable(env, admin, booking.user_id);
  if (reach.error) return notFound('Reservation not found.');

  const body = await readJson(request);

  // Blank is not nought. Clearing puts the trip back on the standing
  // agreement; a deliberate 0 means the agency keeps everything, which is a
  // real arrangement for a house account.
  let pct = null;
  const raw = body.advisorSplitPct;
  if (raw !== null && raw !== undefined && String(raw).trim() !== '') {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      return badRequest('A share is a number between 0 and 100, or blank to follow the agreement.');
    }
    pct = Math.round(n * 10) / 10;
  }

  const updated = await db.setBookingSplit(env, bookingId, pct);
  await db.logActivity(env, admin.id, 'admin.booking.split',
    `${booking.client_name}: ${pct === null ? 'follows the agreement' : `${pct}%`}`,
    { bookingId, pct });
  return json({ ok: true, booking: updated });
}

export async function handleSetAdvisorStatus(request, env, userId) {
  const { user: admin, response } = await requireAdmin(request, env);
  if (response) return response;
  const reach = await reachable(env, admin, userId);
  if (reach.error) return reach.error;

  const body = await readJson(request);
  const status = String(body.status || '');
  if (!STATUSES.includes(status)) return badRequest('Unknown status.');
  if (userId === admin.id && status !== 'active') {
    return badRequest('You cannot suspend your own account.');
  }

  const before = await db.getUserById(env, userId);
  if (!before) return notFound('Advisor not found.');

  const updated = await db.setUserStatus(env, userId, status, admin.id);

  // Suspending must take effect immediately, not at session expiry.
  if (status !== 'active') await db.deleteUserSessions(env, userId);

  // Only email on the pending to active transition, so re-saving an already
  // active advisor does not spam them.
  if (status === 'active' && before.status === 'pending') {
    await sendAdvisorApprovedEmail(env, updated).catch(() => {});
  }

  await db.logActivity(env, admin.id, 'admin.status',
    `Set ${updated.email} to ${status}`, { userId, status });
  return json({ ok: true, user: publicUser(updated) });
}

/**
 * Set an advisor's standing share of the commission they bill.
 *
 * Owner only, and deliberately so: an associate who could set their own split
 * could pay themselves. Blank clears the agreement, which is not the same as
 * setting it to zero, so the two are kept apart all the way down.
 */
/**
 * Hand a reservation to the advisor it should have been taken under.
 *
 * A trip typed in by the owner without first working as the advisor lands on
 * the owner's book: their production, their commission, their statement. The
 * only fix was to type the whole thing in again and delete the first one,
 * which loses the payments, the travellers and the date it was sold.
 *
 * Both ends are checked, not just one. The reservation has to be reachable by
 * this owner and so does the advisor receiving it, or an owner of one agency
 * could push work into another's book.
 */
export async function handleSetBookingAdvisor(request, env, bookingId) {
  const { user: admin, response } = await requireAdmin(request, env);
  if (response) return response;

  const booking = await db.getBookingUnscoped(env, bookingId);
  if (!booking) return notFound('Reservation not found.');
  const from = await reachable(env, admin, booking.user_id);
  if (from.error) return notFound('Reservation not found.');

  const body = await readJson(request);
  const toId = clean(body.userId, 64);
  if (!toId) return badRequest('Pick the advisor it belongs to.');
  if (toId === booking.user_id) return badRequest('It is already theirs.');

  const to = await reachable(env, admin, toId);
  if (to.error) return to.error;
  if (to.target.status !== 'active') {
    return badRequest('That account is not active, so nothing can be filed under it.');
  }

  const { moved, movedClient } = await db.reassignBooking(
    env, bookingId, booking.user_id, toId
  );

  const named = (u) => [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email;
  await db.logActivity(env, admin.id, 'admin.booking.advisor',
    `${booking.client_name}: moved from ${named(from.target)} to ${named(to.target)}`,
    { bookingId, from: booking.user_id, to: toId, rows: moved, client: movedClient });

  // Said on both books, because both change. The advisor losing it is the one
  // who will notice a figure move and have nothing to explain it.
  await db.logActivity(env, booking.user_id, 'booking.moved.out',
    `${booking.client_name} moved to ${named(to.target)}, by ${named(admin)}`, { bookingId });
  await db.logActivity(env, toId, 'booking.moved.in',
    `${booking.client_name} moved to you from ${named(from.target)}, by ${named(admin)}`,
    { bookingId });

  return json({
    ok: true,
    advisor: named(to.target),
    // What actually moved, so the page can say whether the client came too
    // rather than leaving somebody to find out by clicking their name.
    rows: moved,
    movedClient,
    was: named(from.target),
  });
}

export async function handleSetAdvisorSplit(request, env, userId) {
  const { user: admin, response } = await requireAdmin(request, env);
  if (response) return response;
  const reach = await reachable(env, admin, userId);
  if (reach.error) return reach.error;

  const body = await readJson(request);
  const raw = body.defaultSplitPct;
  let pct = null;
  if (raw !== null && raw !== undefined && String(raw).trim() !== '') {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      return badRequest('A share is a number between 0 and 100, or blank for no agreement.');
    }
    pct = Math.round(n * 10) / 10;
  }

  const updated = await db.setUserSplit(env, userId, pct);
  if (!updated) return notFound('Advisor not found.');

  await db.logActivity(env, admin.id, 'admin.split',
    pct === null
      ? `Cleared the commission split for ${updated.email}`
      : `Set ${updated.email} to keep ${pct}% of what they bill`,
    { userId, pct });
  return json({ ok: true, user: publicUser(updated) });
}

/**
 * Bring reservation statuses up to date now rather than on the next cron.
 *
 * The sweep runs every few minutes on its own. This exists so it can be run
 * on demand, which is what you want after an import brings in a book of past
 * trips and the reports still say nobody has travelled.
 */
export async function handleRunLifecycle(request, env) {
  const { user: admin, response } = await requireAdmin(request, env);
  if (response) return response;

  const today = new Date().toISOString().slice(0, 10);
  const moved = await db.markReturnedTripsTravelled(env, { today });
  return json({ ok: true, travelled: moved });
}

/**
 * Configuration health, admin only.
 *
 * Reports whether each secret and binding is actually reachable at runtime.
 * Deliberately reports presence only, never a value, so it is safe to call
 * from the browser and safe to paste into a support thread.
 */
/** Pull the sailing catalog from the copy CruiseShoppers already holds. */
export async function handleMirrorCatalog(request, env) {
  const { user, response } = await requireAdmin(request, env);
  if (response) return response;

  const body = await readJson(request);
  const result = await mirrorCatalogStep(env, {
    maxShips: Math.min(Math.max(Number(body.ships) || 25, 1), 60),
    force: body.force === true,
  });
  await db.logActivity(env, user.id, 'catalog.mirror', 'Imported sailings', result);
  return json({ ...result, status: await mirrorStatus(env) });
}

export async function handleMirrorStatus(request, env) {
  const { response } = await requireAdmin(request, env);
  if (response) return response;
  return json(await mirrorStatus(env));
}

export async function handleHealth(request, env) {
  const { response } = await requireAdmin(request, env);
  if (response) return response;

  const url = new URL(request.url);
  const probe = url.searchParams.get('probe');
  const wantScopes = probe === '1';
  const wantFull = probe === 'full';
  const wantEmail = probe === 'email' || wantFull;

  let dbOk = false;
  let userCount = 0;
  try {
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
    userCount = row?.n ?? 0;
    dbOk = true;
  } catch (e) {
    console.error('health db', e);
  }

  const schema = dbOk ? await schemaDrift(env) : null;

  // What the cron has been doing. Cheap, one query, and the only place the
  // answer to "are the reminders still going out" exists at all.
  const jobs = dbOk ? await jobHealth(env) : { jobs: [], ok: false, error: 'no database' };

  const resend = wantEmail ? await checkResend(env) : null;

  return json({
    email: {
      resendKeyPresent: Boolean(env.RESEND_API_KEY),
      mailFrom: env.MAIL_FROM || null,
      notifyEmail: env.NOTIFY_EMAIL || null,
      resend,
    },
    db: { ok: dbOk, users: userCount },
    // When each scheduled job last ran, and when it last ran without throwing.
    // Those two being far apart is a job that has been failing quietly.
    jobs,
    // Whether the database has had every migration applied. Migrations here
    // are run by hand, so this is the one fact about the system that the
    // repository cannot tell you.
    schema,
    appUrl: env.APP_URL || null,
    // Names of every binding and var the Worker can actually see. Values are
    // never included; this is here to catch a secret saved under the wrong
    // name or in the build environment instead of the runtime one.
    visibleKeys: Object.keys(env).sort(),
  });
}

/** Admin only. Sends a real email and returns Resend's actual response. */
/**
 * Run the daily "what is due" pass now, ignoring the hour.
 *
 * The pass is meant to fire once a morning, which makes it the hardest thing
 * here to check: waiting until tomorrow to find out whether it works is not
 * testing it. Admin only, and it sends for real, so the stamps it writes are
 * the real stamps: a task told about here is not told about again.
 */
export async function handleRunTaskReminders(request, env) {
  const { user, response } = await requireAdmin(request, env);
  if (response) return response;
  const result = await remindTasks(env, { force: true });
  await db.logActivity(env, user.id, 'admin.taskReminders', 'Ran the task reminder pass', result);
  return json(result);
}

/**
 * Run the client payment reminder pass now.
 *
 * It sends for real, to real clients, so this is the one admin button that can
 * be embarrassing. It obeys the same rules as the cron: advisors who turned it
 * on, hard deadlines only, and one notice per lead time.
 */
export async function handleRunPaymentReminders(request, env) {
  const { user, response } = await requireAdmin(request, env);
  if (response) return response;
  const result = await remindDuePayments(env);
  await db.logActivity(env, user.id, 'admin.paymentReminders',
    'Ran the client payment reminder pass', result);
  return json(result);
}

/**
 * Send the weekly call list now, whatever day it is.
 *
 * It goes to advisors rather than to clients, so this is the safe one of the
 * three. It still writes the real stamp: an advisor sent one here does not get
 * another on Monday, which is the point of pressing it on a Friday to see what
 * it looks like.
 */
export async function handleRunCallLists(request, env) {
  const { user, response } = await requireAdmin(request, env);
  if (response) return response;
  const body = await readJson(request).catch(() => ({}));
  const result = await sendCallLists(env, {
    force: true,
    // Just to whoever pressed it, unless they ask for everybody. Trying the
    // wording out should not put an email in nine other inboxes.
    only: body && body.everyone ? null : user.id,
  });
  await db.logActivity(env, user.id, 'admin.callLists', 'Sent the weekly call list', result);
  return json(result);
}

export async function handleTestEmail(request, env) {
  const { user, response } = await requireAdmin(request, env);
  if (response) return response;

  const body = await readJson(request);
  const to = clean(body.to, 254) || user.email;
  if (!to) return badRequest('No address to send to.');

  const result = await sendTestEmail(env, to);
  await db.logActivity(env, user.id, 'admin.testEmail', `Test email to ${to}`, { ok: result.ok });
  return json(result, result.ok ? 200 : 502);
}

