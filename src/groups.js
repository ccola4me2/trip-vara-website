// Group space: cabins a vendor holds before anybody has booked them.
//
// The number that matters is not how many cabins are in the block, it is how
// many are still unsold and how long is left before the vendor takes them
// back. That is the option date, and it behaves exactly like a final payment
// deadline: nothing happens when it passes except that your space quietly
// disappears.
//
// Cabins sold is counted from the reservations pointing at the group rather
// than stored on it. Two numbers that can disagree eventually will.

import { json, badRequest, notFound, clean, cleanDate, oneOf, uid, now, readJson } from './util.js';
import { requireUser } from './auth.js';
import * as db from './db.js';

const STATUSES = ['open', 'closed', 'cancelled'];

const COLUMNS = `
  g.id, g.user_id, g.name, g.vendor, g.product_name, g.destination, g.group_code,
  g.depart_date, g.return_date, g.option_date, g.cabins_held, g.status, g.notes,
  g.created_at, g.updated_at
`;

const SOLD = `(SELECT COUNT(*) FROM bookings b
                WHERE b.group_id = g.id AND b.status IN ('quoted','booked','travelled')) AS cabins_sold`;

const ADVISOR = `COALESCE(NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), ''), u.email)
                   AS advisor_name`;

function parse(body) {
  const name = clean(body.name, 160);
  if (!name) return { error: 'Give the group a name.' };

  const departDate = cleanDate(body.departDate);
  const returnDate = cleanDate(body.returnDate);
  if (departDate && returnDate && returnDate < departDate) {
    return { error: 'The return date cannot be before the departure date.' };
  }

  const optionDate = cleanDate(body.optionDate);
  if (optionDate && departDate && optionDate > departDate) {
    return { error: 'The option date falls after departure, which cannot be right.' };
  }

  return {
    fields: {
      name,
      vendor: clean(body.vendor, 120),
      productName: clean(body.productName, 160),
      destination: clean(body.destination, 160),
      groupCode: clean(body.groupCode, 80),
      departDate,
      returnDate,
      optionDate,
      cabinsHeld: Math.max(0, Math.min(Number(body.cabinsHeld) || 0, 9999)),
      status: oneOf(body.status, STATUSES),
      notes: clean(body.notes, 4000),
    },
  };
}

export async function listGroups(env, scope, { status, limit = 200 } = {}) {
  const scoped = db.scopeWhere(scope, 'g.user_id');
  const where = [scoped.sql];
  const binds = [...scoped.binds];
  if (status) { where.push('g.status = ?'); binds.push(status); }

  const { results } = await env.DB.prepare(
    `SELECT ${COLUMNS}, ${SOLD}, ${ADVISOR}
       FROM travel_groups g LEFT JOIN users u ON u.id = g.user_id
      WHERE ${where.join(' AND ')}
      ORDER BY COALESCE(g.depart_date, '9999-12-31') ASC LIMIT ?`
  ).bind(...binds, Math.min(Number(limit) || 200, 500)).all();
  return results || [];
}

export async function handleListGroups(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const url = new URL(request.url);
  const statusParam = url.searchParams.get('status');
  const scope = db.scopeFor(env, user, request);
  const groups = await listGroups(env, scope, {
    status: STATUSES.includes(statusParam) ? statusParam : undefined,
  });

  const today = new Date().toISOString().slice(0, 10);
  const open = groups.filter((g) => g.status === 'open');
  return json({
    groups,
    today,
    stats: {
      open: open.length,
      held: open.reduce((n, g) => n + (g.cabins_held || 0), 0),
      sold: open.reduce((n, g) => n + (g.cabins_sold || 0), 0),
      // Space about to go back to the vendor is the whole reason this screen
      // exists, so it is a headline figure rather than something to notice.
      releasing: open.filter((g) => g.option_date && g.option_date >= today
        && g.option_date <= isoAhead(30))
        .reduce((n, g) => n + Math.max(0, (g.cabins_held || 0) - (g.cabins_sold || 0)), 0),
    },
    scope: db.scopeLabel(scope, user),
    advisors: await db.advisorOptions(env, user),
  });
}

function isoAhead(days) {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
}

async function getGroup(env, id, userId) {
  return env.DB.prepare(
    `SELECT ${COLUMNS}, ${SOLD} FROM travel_groups g WHERE g.id = ? AND g.user_id = ?`
  ).bind(id, userId).first();
}

export async function handleGetGroup(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const scope = db.scopeFor(env, user, request);
  const scoped = db.scopeWhere(scope, 'g.user_id');
  const group = await env.DB.prepare(
    `SELECT ${COLUMNS}, ${SOLD}, ${ADVISOR}
       FROM travel_groups g LEFT JOIN users u ON u.id = g.user_id
      WHERE g.id = ? AND ${scoped.sql}`
  ).bind(id, ...scoped.binds).first();
  if (!group) return notFound('Group not found.');

  // The reservations in the block, read at the same scope as the group.
  const bScoped = db.scopeWhere(scope, 'b.user_id');
  const { results } = await env.DB.prepare(
    `SELECT b.id, b.client_name, b.confirmation_number, b.travellers, b.status,
            b.gross_cents, b.commission_cents, b.depart_date
       FROM bookings b WHERE b.group_id = ? AND ${bScoped.sql}
      ORDER BY b.created_at ASC`
  ).bind(id, ...bScoped.binds).all();

  return json({ group, bookings: results || [] });
}

export async function handleCreateGroup(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const { fields, error } = parse(await readJson(request));
  if (error) return badRequest(error);

  const id = uid();
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO travel_groups (id, user_id, name, vendor, product_name, destination,
       group_code, depart_date, return_date, option_date, cabins_held, status, notes,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, user.id, fields.name, fields.vendor, fields.productName, fields.destination,
         fields.groupCode, fields.departDate, fields.returnDate, fields.optionDate,
         fields.cabinsHeld, fields.status, fields.notes, ts, ts).run();

  await db.logActivity(env, user.id, 'group.create', `Opened group ${fields.name}`, { id });
  return json({ ok: true, group: await getGroup(env, id, user.id) }, 201);
}

export async function handleUpdateGroup(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const { fields, error } = parse(await readJson(request));
  if (error) return badRequest(error);

  const res = await env.DB.prepare(
    `UPDATE travel_groups SET name = ?, vendor = ?, product_name = ?, destination = ?,
       group_code = ?, depart_date = ?, return_date = ?, option_date = ?,
       cabins_held = ?, status = ?, notes = ?, updated_at = ?
     WHERE id = ? AND user_id = ?`
  ).bind(fields.name, fields.vendor, fields.productName, fields.destination, fields.groupCode,
         fields.departDate, fields.returnDate, fields.optionDate, fields.cabinsHeld,
         fields.status, fields.notes, now(), id, user.id).run();
  if (!res.meta || res.meta.changes === 0) return notFound('Group not found.');

  return json({ ok: true, group: await getGroup(env, id, user.id) });
}

export async function handleDeleteGroup(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  // Reservations survive their group. Deleting a block should not delete the
  // bookings made out of it, which are real trips people have paid for.
  await env.DB.prepare('UPDATE bookings SET group_id = NULL WHERE group_id = ? AND user_id = ?')
    .bind(id, user.id).run();
  const res = await env.DB.prepare('DELETE FROM travel_groups WHERE id = ? AND user_id = ?')
    .bind(id, user.id).run();
  if (!res.meta || res.meta.changes === 0) return notFound('Group not found.');
  return json({ ok: true });
}
