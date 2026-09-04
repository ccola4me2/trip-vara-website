// Admin: approve advisor accounts, bind them to a GoHighLevel sub-account,
// and suspend access.

import { json, badRequest, notFound, clean, readJson } from './util.js';
import { requireAdmin, publicUser } from './auth.js';
import * as db from './db.js';
import { sendAdvisorApprovedEmail } from './email.js';

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
