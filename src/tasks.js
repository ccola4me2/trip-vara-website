// The advisor's own task list.
//
// Kept local rather than mirrored from the CRM for three reasons: it has to
// stay writable when the upstream API is slow, it links to reservations, which
// the CRM knows nothing about, and a working list that disappears during an
// outage is worse than no list at all.
//
// Reads use the visibility scope, so an owner sees the agency's workload and
// an associate sees their own. Writes always use selfScope: seeing someone
// else's task is not the same as ticking it off for them.

import { json, badRequest, notFound, clean, cleanDate, oneOf, uid, now, readJson } from './util.js';
import { requireUser } from './auth.js';
import * as db from './db.js';

// Order matters: oneOf falls back to the first entry, so normal has to lead or
// every task created without an explicit priority comes out as high.
const PRIORITIES = ['normal', 'high', 'low'];

const COLUMNS = `
  t.id, t.user_id, t.title, t.notes, t.due_date, t.priority,
  t.booking_id, t.contact_id, t.done_at, t.pinned_at, t.created_at, t.updated_at
`;

function parse(body) {
  const title = clean(body.title, 200);
  if (!title) return { error: 'Give the task a title.' };
  return {
    fields: {
      title,
      notes: clean(body.notes, 2000),
      dueDate: cleanDate(body.dueDate),
      priority: oneOf(body.priority, PRIORITIES),
      bookingId: clean(body.bookingId, 64) || null,
      contactId: clean(body.contactId, 64) || null,
    },
  };
}

/**
 * Open tasks, soonest first, with undated ones last.
 *
 * A task with no date is a someday task, not an urgent one, and sorting NULL
 * to the top would put the whole "one day" pile above this afternoon's work.
 */
export async function listTasks(env, scope, { state = 'open', limit = 200 } = {}) {
  const scoped = db.scopeWhere(scope, 't.user_id');
  const where = [scoped.sql];
  if (state === 'open') where.push('t.done_at IS NULL');
  if (state === 'done') where.push('t.done_at IS NOT NULL');

  // Pinned first, then by date. A pin means "this is what I am on now", which
  // outranks any date, and it is the whole reason for pinning.
  const order = state === 'done'
    ? 't.done_at DESC'
    : "t.pinned_at IS NULL ASC, t.pinned_at ASC, COALESCE(t.due_date, '9999-12-31') ASC, "
      + "CASE t.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END ASC";

  const { results } = await env.DB.prepare(
    `SELECT ${COLUMNS},
            b.client_name AS booking_client, b.supplier AS booking_supplier,
            COALESCE(NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), ''), u.email)
              AS advisor_name
       FROM tasks t
       LEFT JOIN bookings b ON b.id = t.booking_id
       LEFT JOIN users u ON u.id = t.user_id
      WHERE ${where.join(' AND ')}
      ORDER BY ${order} LIMIT ?`
  ).bind(...scoped.binds, Math.min(Number(limit) || 200, 500)).all();
  return results || [];
}

export async function handleListTasks(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const url = new URL(request.url);
  const state = oneOf(url.searchParams.get('state'), ['open', 'done', 'all']) || 'open';
  const scope = db.scopeFor(env, user, request);
  const tasks = await listTasks(env, scope, { state });

  const today = new Date().toISOString().slice(0, 10);
  return json({
    tasks,
    counts: {
      overdue: tasks.filter((t) => !t.done_at && t.due_date && t.due_date < today).length,
      today: tasks.filter((t) => !t.done_at && t.due_date === today).length,
      open: tasks.filter((t) => !t.done_at).length,
      pinned: tasks.filter((t) => !t.done_at && t.pinned_at).length,
      thisWeek: tasks.filter((t) => !t.done_at && t.due_date
        && t.due_date > today && t.due_date <= weekFrom(today)).length,
    },
    today,
    scope: db.scopeLabel(scope, user),
    advisors: await db.advisorOptions(env, user),
  });
}

/** The end of the seventh day from today, so "this week" means the week ahead. */
function weekFrom(today) {
  return new Date(Date.parse(`${today}T00:00:00Z`) + 7 * 86400000).toISOString().slice(0, 10);
}

export async function handleCreateTask(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const { fields, error } = parse(await readJson(request));
  if (error) return badRequest(error);

  // A task may point at a reservation, but only one this advisor owns.
  // Otherwise the link is a way to confirm that someone else's booking exists.
  if (fields.bookingId && !(await db.getBooking(env, fields.bookingId, user.id))) {
    return badRequest('That reservation is not yours.');
  }

  const id = uid();
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO tasks (id, user_id, title, notes, due_date, priority, booking_id,
       contact_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, user.id, fields.title, fields.notes || null, fields.dueDate,
         fields.priority, fields.bookingId, fields.contactId, ts, ts).run();

  await db.logActivity(env, user.id, 'task.create', `Added task: ${fields.title}`, { id });
  return json({ ok: true, task: await getTask(env, id, user.id) }, 201);
}

async function getTask(env, id, userId) {
  return env.DB.prepare(
    `SELECT ${COLUMNS}, b.client_name AS booking_client, b.supplier AS booking_supplier
       FROM tasks t LEFT JOIN bookings b ON b.id = t.booking_id
      WHERE t.id = ? AND t.user_id = ?`
  ).bind(id, userId).first();
}

export async function handleUpdateTask(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);

  // Pinning is its own request shape for the same reason as ticking off: it
  // happens constantly and should not need the whole record sent back.
  if (Object.prototype.hasOwnProperty.call(body, 'pinned')) {
    const res = await env.DB.prepare(
      'UPDATE tasks SET pinned_at = ?, updated_at = ? WHERE id = ? AND user_id = ?'
    ).bind(body.pinned ? now() : null, now(), id, user.id).run();
    if (!res.meta || res.meta.changes === 0) return notFound('Task not found.');
    return json({ ok: true, task: await getTask(env, id, user.id) });
  }

  // Ticking a task off is its own request shape, because it is the thing
  // people do most and should not require sending the whole record back.
  if (Object.prototype.hasOwnProperty.call(body, 'done')) {
    const res = await env.DB.prepare(
      'UPDATE tasks SET done_at = ?, updated_at = ? WHERE id = ? AND user_id = ?'
    ).bind(body.done ? now() : null, now(), id, user.id).run();
    if (!res.meta || res.meta.changes === 0) return notFound('Task not found.');
    return json({ ok: true, task: await getTask(env, id, user.id) });
  }

  const { fields, error } = parse(body);
  if (error) return badRequest(error);
  if (fields.bookingId && !(await db.getBooking(env, fields.bookingId, user.id))) {
    return badRequest('That reservation is not yours.');
  }

  const res = await env.DB.prepare(
    `UPDATE tasks SET title = ?, notes = ?, due_date = ?, priority = ?,
       booking_id = ?, contact_id = ?, updated_at = ?
     WHERE id = ? AND user_id = ?`
  ).bind(fields.title, fields.notes || null, fields.dueDate, fields.priority,
         fields.bookingId, fields.contactId, now(), id, user.id).run();
  if (!res.meta || res.meta.changes === 0) return notFound('Task not found.');

  return json({ ok: true, task: await getTask(env, id, user.id) });
}

export async function handleDeleteTask(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const res = await env.DB.prepare('DELETE FROM tasks WHERE id = ? AND user_id = ?')
    .bind(id, user.id).run();
  if (!res.meta || res.meta.changes === 0) return notFound('Task not found.');
  return json({ ok: true });
}
