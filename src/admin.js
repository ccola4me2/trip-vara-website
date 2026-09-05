// Admin: approve advisor accounts, bind them to a GoHighLevel sub-account,
// and suspend access.

import { json, badRequest, notFound, clean, readJson } from './util.js';
import * as ghl from './ghl.js';
import { listSyncState, runSync, resetSync } from './sync.js';
import { requireAdmin, publicUser } from './auth.js';
import * as db from './db.js';
import { sendAdvisorApprovedEmail, checkResend, sendTestEmail } from './email.js';

const STATUSES = ['pending', 'active', 'suspended'];

export async function handleListAdvisors(request, env) {
  const { response } = await requireAdmin(request, env);
  if (response) return response;

  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  const users = await db.listUsers(env, {
    status: STATUSES.includes(status) ? status : undefined,
  });
  return json({ users: users.map(publicUser), counts: await db.countUsers(env) });
}

export async function handleSetAdvisorStatus(request, env, userId) {
  const { user: admin, response } = await requireAdmin(request, env);
  if (response) return response;

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

export async function handleSetAdvisorGhl(request, env, userId) {
  const { user: admin, response } = await requireAdmin(request, env);
  if (response) return response;

  const body = await readJson(request);
  const updated = await db.setUserGhl(env, userId, {
    locationId: clean(body.ghlLocationId, 64),
    ghlUserId: clean(body.ghlUserId, 64),
  });
  if (!updated) return notFound('Advisor not found.');

  await db.logActivity(env, admin.id, 'admin.ghl',
    `Bound ${updated.email} to location ${updated.ghl_location_id || 'default'}`, { userId });
  return json({ ok: true, user: publicUser(updated) });
}

/**
 * Set an advisor's standing share of the commission they bill.
 *
 * Owner only, and deliberately so: an associate who could set their own split
 * could pay themselves. Blank clears the agreement, which is not the same as
 * setting it to zero, so the two are kept apart all the way down.
 */
export async function handleSetAdvisorSplit(request, env, userId) {
  const { user: admin, response } = await requireAdmin(request, env);
  if (response) return response;

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
 * Configuration health, admin only.
 *
 * Reports whether each secret and binding is actually reachable at runtime.
 * Deliberately reports presence only, never a value, so it is safe to call
 * from the browser and safe to paste into a support thread.
 */
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

  let scopes = null;
  let capabilities = null;
  const resend = wantEmail ? await checkResend(env) : null;
  if (ghl.ghlConfigured(env)) {
    const loc = env.GHL_DEFAULT_LOCATION_ID || '';
    if (wantScopes) scopes = await ghl.probeScopes(env, loc);
    if (wantFull) capabilities = await ghl.probeCapabilities(env, loc);
  }

  return json({
    ghl: {
      tokenPresent: Boolean(env.GHL_API_TOKEN),
      tokenLength: env.GHL_API_TOKEN ? String(env.GHL_API_TOKEN).length : 0,
      defaultLocationId: env.GHL_DEFAULT_LOCATION_ID || null,
      apiBase: env.GHL_API_BASE || null,
      apiVersion: env.GHL_API_VERSION || null,
    },
    email: {
      resendKeyPresent: Boolean(env.RESEND_API_KEY),
      mailFrom: env.MAIL_FROM || null,
      notifyEmail: env.NOTIFY_EMAIL || null,
      resend,
    },
    db: { ok: dbOk, users: userCount },
    appUrl: env.APP_URL || null,
    // Which GHL areas this token can actually reach. Skipped unless asked for,
    // since it costs one API call per area.
    scopes,
    capabilities,
    // Names of every binding and var the Worker can actually see. Values are
    // never included; this is here to catch a secret saved under the wrong
    // name or in the build environment instead of the runtime one.
    visibleKeys: Object.keys(env).sort(),
  });
}

/** Admin only. Sends a real email and returns Resend's actual response. */
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

/** Admin only. Sync status for the default location. */
export async function handleSyncStatus(request, env) {
  const { user, response } = await requireAdmin(request, env);
  if (response) return response;
  const locationId = ghl.locationFor(env, user);
  return json({
    locationId,
    jobs: await listSyncState(env, locationId),
    counts: await db.crmCounts(env, locationId),
  });
}

/** Admin only. Runs a sync pass now. force=true restarts from scratch. */
export async function handleRunSync(request, env) {
  const { user, response } = await requireAdmin(request, env);
  if (response) return response;
  const body = await readJson(request);
  const locationId = ghl.locationFor(env, user);
  const result = await runSync(env, locationId, { force: Boolean(body.force) });
  await db.logActivity(env, user.id, 'admin.sync',
    body.force ? 'Started a full resync' : 'Ran a sync pass', result);
  return json({ ok: true, result, jobs: await listSyncState(env, locationId) });
}
