// A fourteen day demo an agency runs with their own clients.
//
// The countdown is the easy half. The hard half is that the people trying this
// are strangers putting real client names, emails and phone numbers into
// somebody else's portal, so a demo is never a login inside an existing
// agency: it is its own agency, created at signup, and the fence that already
// separates one agency's book from another's is what protects them.
//
// That distinction is load bearing. /signup with no join link drops the new
// advisor into the first agency on the books, which is the house one. A demo
// taking that path would file a stranger's clients in Brent's own book and
// show them his. Nothing below calls houseAgency.
//
// Converting keeps everything. A demo that becomes a paying agency is the same
// agency row with the trial switched off: no copy, no migration, not one
// record moved. Every client, reservation and payment they entered during the
// trial is exactly where they left it.

import {
  json, badRequest, notFound, clean, isValidEmail, normalizeEmail, uid, now, readJson,
  sha256Hex,
  hashPassword,
} from './util.js';
import { requireAdmin } from './auth.js';
import * as db from './db.js';
import { EXPECTED_SCHEMA } from './schema-expected.js';

export const TRIAL_DAYS = 14;
// How long a locked demo is kept before it is removed. Long enough that
// nobody loses their work by being a week late paying, short enough that the
// portal is not holding a stranger's client list for ever.
export const KEEP_LOCKED_DAYS = 30;

const DAY = 86400;

/** Seconds until a trial ends. Negative once it has. */
export function trialLeft(agency, at = now()) {
  if (!agency || !agency.trial_ends_at) return null;
  return agency.trial_ends_at - at;
}

/** Whether this agency may still be used. Live agencies always may. */
export function trialBlocks(agency, at = now()) {
  if (!agency) return false;
  if (agency.plan !== 'demo') return false;
  if (!agency.trial_ends_at) return false;
  return agency.trial_ends_at <= at;
}

/**
 * Every table that records who owns a row.
 *
 * Read out of the generated schema rather than written here, so a table added
 * next month is covered the day it exists. A hand written list is how a demo
 * gets deleted and leaves one table's worth of somebody's clients behind.
 *
 * This database does not enforce foreign keys, so nothing cascades: the rows
 * have to be named.
 */
export function userOwnedTables() {
  return Object.keys(EXPECTED_SCHEMA)
    .filter((t) => (EXPECTED_SCHEMA[t] || []).includes('user_id'))
    .filter((t) => /^[a-z_]+$/.test(t))
    .sort();
}

/**
 * Start a demo.
 *
 * Public, because a demo somebody has to ask permission for is not a demo. It
 * creates an agency and its first owner in one go, and the account is active
 * at once rather than pending: waiting on approval for a trial is the same as
 * not having one.
 */
export async function handleStartDemo(request, env) {
  const body = await readJson(request);

  // A bot fills every field it finds. Thanked rather than told.
  if (clean(body.company_website, 200)) return json({ ok: true, started: true });

  const email = normalizeEmail(clean(body.email, 254));
  const firstName = clean(body.firstName, 80);
  const lastName = clean(body.lastName, 80);
  const agencyName = clean(body.agencyName, 120);
  const password = String(body.password || '');

  if (!isValidEmail(email)) return badRequest('Enter a working email address.');
  if (!firstName || !lastName) return badRequest('First and last name are both needed.');
  if (!agencyName) return badRequest('What is the agency called?');
  if (password.length < 10) return badRequest('A password of at least 10 characters, please.');

  // Said plainly rather than hidden. The rest of the portal refuses to confirm
  // whether an address is registered; here the alternative is a stranger
  // filling in a form, being told nothing happened, and giving up. A demo
  // signup that silently does nothing is a demo nobody takes.
  if (await db.emailExists(env, email)) {
    return badRequest('That address already has an account. Sign in, or use another address.');
  }

  const ip = request.headers.get('CF-Connecting-IP') || '';
  const ipHash = ip ? (await sha256Hex(`demo:${ip}`)).slice(0, 32) : null;
  if (ipHash) {
    const seen = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM agencies WHERE demo_ip_hash = ? AND created_at > ?'
    ).bind(ipHash, now() - DAY).first();
    if ((seen?.n || 0) >= 3) {
      return json({ error: 'That is a lot of demos from one place. Get in touch instead.' }, 429);
    }
  }

  const ts = now();
  const agencyId = uid();
  const slug = await freeDemoSlug(env, agencyName);

  await env.DB.prepare(
    `INSERT INTO agencies (id, name, slug, tagline, join_open, plan, trial_ends_at,
       demo_email, demo_ip_hash, created_at, updated_at)
     VALUES (?, ?, ?, NULL, 0, 'demo', ?, ?, ?, ?, ?)`
    // join_open is 0 on purpose. A demo's join link would let anybody who
    // guessed the slug walk into a stranger's trial and read their clients.
  ).bind(agencyId, agencyName, slug, ts + (TRIAL_DAYS * DAY), email, ipHash, ts, ts).run();

  const user = await db.createUser(env, {
    email,
    passwordHash: await hashPassword(password),
    firstName,
    lastName,
    agencyName,
    // The owner of their own agency, and nothing beyond it. platform_owner
    // stays 0, which is what keeps every other agency invisible to them.
    role: 'admin',
    status: 'active',
    agencyId,
  });

  await db.logActivity(env, user.id, 'demo.start', `Started a demo for ${agencyName}`,
    { agencyId, trialDays: TRIAL_DAYS });

  return json({
    ok: true,
    started: true,
    trialDays: TRIAL_DAYS,
    endsAt: ts + (TRIAL_DAYS * DAY),
    message: 'Your demo is ready. Sign in and start putting your own clients in.',
  }, 201);
}

function slugify(name) {
  return String(name).toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'agency';
}

async function freeDemoSlug(env, name) {
  const base = slugify(name);
  for (let i = 0; i < 25; i += 1) {
    const slug = i === 0 ? base : `${base}-${i + 1}`;
    const clash = await env.DB.prepare('SELECT id FROM agencies WHERE slug = ?').bind(slug).first();
    if (!clash) return slug;
  }
  return `${base}-${uid().slice(0, 8)}`;
}

/**
 * Turn a demo into a paying agency.
 *
 * The same row, with the trial switched off. Nothing is copied and nothing is
 * moved: every client, reservation and payment entered during the trial stays
 * exactly where it is, which is the only sane answer to "what happens to my
 * data if I sign up".
 */
export async function handleConvertAgency(request, env, id) {
  const { user, response } = await requireAdmin(request, env);
  if (response) return response;
  if (!user.platform_owner) {
    return json({ error: 'Only the portal owner can do that.' }, 403);
  }

  const body = await readJson(request).catch(() => ({}));
  const toDemo = body.plan === 'demo';

  if (toDemo) {
    // Either a number of days from today, or an explicit date. The second is
    // what an operator wants when they are ending a trial now rather than
    // granting one, and saying "minus three days" to mean that is a worse
    // interface than saying when.
    const endsAt = Number.isFinite(Number(body.endsAt)) && body.endsAt !== null
      && body.endsAt !== undefined && String(body.endsAt).trim() !== ''
      ? Math.trunc(Number(body.endsAt))
      : now() + (Math.max(1, Math.min(Number(body.days) || TRIAL_DAYS, 365)) * DAY);

    await env.DB.prepare(
      `UPDATE agencies SET plan = 'demo', trial_ends_at = ?, locked_at = NULL, updated_at = ?
        WHERE id = ?`
    ).bind(endsAt, now(), id).run();
    await db.logActivity(env, user.id, 'agency.trial', 'Set a trial end date', { id, endsAt });
    return json({ ok: true, plan: 'demo', endsAt });
  }

  await env.DB.prepare(
    `UPDATE agencies SET plan = 'live', trial_ends_at = NULL, locked_at = NULL, updated_at = ?
      WHERE id = ?`
  ).bind(now(), id).run();
  await db.logActivity(env, user.id, 'agency.convert', 'Converted a demo to a live agency', { id });
  return json({ ok: true, plan: 'live' });
}

/**
 * Lock the demos that have run out, and remove the ones locked long enough.
 *
 * Every condition here is a guard, and they are deliberately more than are
 * needed. A sweep that deletes agencies is the one piece of this portal that
 * can destroy somebody's book, so it refuses anything it is not certain about:
 * only agencies on the demo plan, only ones with a trial date, only ones
 * already locked and locked long enough, never the house agency, and never an
 * agency containing somebody who runs the portal.
 */
export async function sweepDemos(env, { at = now(), limit = 50 } = {}) {
  const out = { locked: 0, deleted: 0, rows: 0, kept: 0 };

  // The oldest agency is the house one: the migration that introduced
  // agencies put everybody in it, and houseAgency picks it the same way.
  const house = await env.DB.prepare(
    'SELECT id FROM agencies ORDER BY created_at ASC LIMIT 1'
  ).first();
  const houseId = house ? house.id : '';

  const { results: due } = await env.DB.prepare(
    `SELECT id, name FROM agencies
      WHERE plan = 'demo' AND trial_ends_at IS NOT NULL AND trial_ends_at <= ?
        AND locked_at IS NULL AND id <> ?
      LIMIT ?`
  ).bind(at, houseId, limit).all();

  for (const a of due || []) {
    await env.DB.prepare('UPDATE agencies SET locked_at = ?, updated_at = ? WHERE id = ?')
      .bind(at, at, a.id).run();
    out.locked += 1;
  }

  const { results: gone } = await env.DB.prepare(
    `SELECT a.id, a.name FROM agencies a
      WHERE a.plan = 'demo' AND a.locked_at IS NOT NULL AND a.locked_at <= ?
        AND a.id <> ?
        AND NOT EXISTS (SELECT 1 FROM users u WHERE u.agency_id = a.id AND u.platform_owner = 1)
      LIMIT ?`
  ).bind(at - (KEEP_LOCKED_DAYS * DAY), houseId, limit).all();

  for (const a of gone || []) {
    out.rows += await purgeAgency(env, a.id);
    out.deleted += 1;
  }

  return out;
}

/**
 * Remove an agency and everything its people own.
 *
 * Named table by table because this database does not enforce foreign keys, so
 * nothing cascades on its own. The list comes out of the generated schema, so
 * a table added later is covered without anybody remembering to come back
 * here, which is the failure that would leave one table's worth of a
 * stranger's clients behind after we told them it was gone.
 */
export async function purgeAgency(env, agencyId) {
  const { results: people } = await env.DB.prepare(
    'SELECT id FROM users WHERE agency_id = ? AND platform_owner = 0'
  ).bind(agencyId).all();
  const ids = (people || []).map((p) => p.id);
  if (!ids.length) {
    await env.DB.prepare('DELETE FROM agencies WHERE id = ?').bind(agencyId).run();
    return 0;
  }

  const marks = ids.map(() => '?').join(',');
  let rows = 0;
  for (const table of userOwnedTables()) {
    // The table name is interpolated and can only be one of the names in the
    // generated schema, filtered to plain lower case words above.
    const res = await env.DB.prepare(
      `DELETE FROM ${table} WHERE user_id IN (${marks})`
    ).bind(...ids).run().catch(() => null);
    rows += res?.meta?.changes || 0;
  }

  await env.DB.prepare(`DELETE FROM users WHERE id IN (${marks})`).bind(...ids).run();
  await env.DB.prepare('DELETE FROM agencies WHERE id = ?').bind(agencyId).run();
  return rows;
}

/**
 * Remove an agency now, rather than waiting for the sweep.
 *
 * For the demo that is plainly never coming back, and for the one somebody
 * asks to be deleted. The same guards as the sweep, because they are the same
 * risk: never the house agency, and never one containing somebody who runs the
 * portal. Live agencies are allowed, deliberately, because "delete us" is a
 * request a real customer can make and refusing it would mean doing it by hand
 * in the database, which is worse.
 */
export async function handleDeleteAgency(request, env, id) {
  const { user, response } = await requireAdmin(request, env);
  if (response) return response;
  if (!user.platform_owner) return json({ error: 'Only the portal owner can do that.' }, 403);

  const house = await env.DB.prepare(
    'SELECT id FROM agencies ORDER BY created_at ASC LIMIT 1'
  ).first();
  if (house && house.id === id) {
    return badRequest('That is the portal\'s own agency. It cannot be removed from here.');
  }
  if (id === user.agency_id) {
    return badRequest('That is your own agency.');
  }

  const owner = await env.DB.prepare(
    'SELECT 1 AS yes FROM users WHERE agency_id = ? AND platform_owner = 1 LIMIT 1'
  ).bind(id).first();
  if (owner) {
    return badRequest('Somebody who runs the portal is in that agency.');
  }

  const agency = await env.DB.prepare('SELECT name FROM agencies WHERE id = ?').bind(id).first();
  if (!agency) return notFound('Agency not found.');

  const rows = await purgeAgency(env, id);
  await db.logActivity(env, user.id, 'agency.remove',
    `Removed ${agency.name} and everything in it`, { id, rows });
  return json({ ok: true, removed: agency.name, rows });
}

/** Run the sweep now, for somebody who does not want to wait a day to find out. */
export async function handleRunDemoSweep(request, env) {
  const { user, response } = await requireAdmin(request, env);
  if (response) return response;
  if (!user.platform_owner) return json({ error: 'Only the portal owner can do that.' }, 403);
  const result = await sweepDemos(env);
  await db.logActivity(env, user.id, 'demo.sweep', 'Ran the demo sweep', result);
  return json(result);
}
