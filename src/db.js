// D1 access layer. Everything that touches the database lives here so the
// route handlers stay readable and the SQL is in one place.
//
// Remember what D1 owns: portal accounts, sessions, and bookings. Contacts,
// opportunities and conversations are read live from GoHighLevel (see ghl.js)
// and are deliberately not mirrored here.

import { uid, now } from './util.js';

const USER_COLUMNS = `
  id, email, first_name, last_name, phone, agency_name, role, status,
  ghl_location_id, ghl_user_id, created_at, updated_at, last_login_at,
  approved_at, approved_by
`;

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------
export async function getUserById(env, id) {
  if (!id) return null;
  return env.DB.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).bind(id).first();
}

/** Includes password_hash. Only for the sign-in path. */
export async function getUserForLogin(env, email) {
  if (!email) return null;
  return env.DB.prepare(
    `SELECT ${USER_COLUMNS}, password_hash FROM users WHERE email = ?`
  ).bind(email).first();
}

export async function emailExists(env, email) {
  const row = await env.DB.prepare('SELECT 1 AS hit FROM users WHERE email = ?').bind(email).first();
  return Boolean(row);
}

export async function createUser(env, fields) {
  const ts = now();
  const id = uid();
  await env.DB.prepare(
    `INSERT INTO users
       (id, email, password_hash, first_name, last_name, phone, agency_name,
        role, status, ghl_location_id, ghl_user_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id,
    fields.email,
    fields.passwordHash,
    fields.firstName || null,
    fields.lastName || null,
    fields.phone || null,
    fields.agencyName || null,
    fields.role || 'advisor',
    fields.status || 'pending',
    fields.ghlLocationId || null,
    fields.ghlUserId || null,
    ts,
    ts
  ).run();
  return getUserById(env, id);
}

export async function updateUserProfile(env, id, fields) {
  await env.DB.prepare(
    `UPDATE users
        SET first_name = ?, last_name = ?, phone = ?, agency_name = ?, updated_at = ?
      WHERE id = ?`
  ).bind(
    fields.firstName || null,
    fields.lastName || null,
    fields.phone || null,
    fields.agencyName || null,
    now(),
    id
  ).run();
  return getUserById(env, id);
}

export async function setUserPassword(env, id, passwordHash) {
  await env.DB.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
    .bind(passwordHash, now(), id).run();
}

export async function setLastLogin(env, id) {
  await env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(now(), id).run();
}

export async function listUsers(env, { status, role } = {}) {
  const where = [];
  const binds = [];
  if (status) { where.push('status = ?'); binds.push(status); }
  if (role) { where.push('role = ?'); binds.push(role); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { results } = await env.DB.prepare(
    `SELECT ${USER_COLUMNS} FROM users ${clause} ORDER BY created_at DESC LIMIT 500`
  ).bind(...binds).all();
  return results || [];
}

export async function setUserStatus(env, id, status, approvedBy = null) {
  const ts = now();
  if (status === 'active') {
    await env.DB.prepare(
      'UPDATE users SET status = ?, approved_at = ?, approved_by = ?, updated_at = ? WHERE id = ?'
    ).bind(status, ts, approvedBy, ts, id).run();
  } else {
    await env.DB.prepare('UPDATE users SET status = ?, updated_at = ? WHERE id = ?')
      .bind(status, ts, id).run();
  }
  return getUserById(env, id);
}

/** Bind an advisor to a GoHighLevel sub-account and user id. Admin only. */
export async function setUserGhl(env, id, { locationId, ghlUserId }) {
  await env.DB.prepare(
    'UPDATE users SET ghl_location_id = ?, ghl_user_id = ?, updated_at = ? WHERE id = ?'
  ).bind(locationId || null, ghlUserId || null, now(), id).run();
  return getUserById(env, id);
}

export async function countUsers(env) {
  const row = await env.DB.prepare(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active
     FROM users WHERE role = 'advisor'`
  ).first();
  return { total: row?.total || 0, pending: row?.pending || 0, active: row?.active || 0 };
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------
export async function createSession(env, userId, tokenHash, ttlSeconds) {
  const ts = now();
  await env.DB.prepare(
    'INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
  ).bind(tokenHash, userId, ts, ts + ttlSeconds).run();
}

export async function getSessionUser(env, tokenHash) {
  if (!tokenHash) return null;
  return env.DB.prepare(
    `SELECT u.id, u.email, u.first_name, u.last_name, u.phone, u.agency_name,
            u.role, u.status, u.ghl_location_id, u.ghl_user_id, u.last_login_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND s.expires_at > ?`
  ).bind(tokenHash, now()).first();
}

export async function deleteSession(env, tokenHash) {
  if (!tokenHash) return;
  await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(tokenHash).run();
}

export async function deleteUserSessions(env, userId) {
  await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run();
}

export async function purgeExpiredSessions(env) {
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now()).run();
}

// ---------------------------------------------------------------------------
// Password resets
// ---------------------------------------------------------------------------
export async function createResetToken(env, userId, tokenHash, ttlSeconds) {
  const ts = now();
  await env.DB.prepare(
    'INSERT INTO password_reset_tokens (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
  ).bind(tokenHash, userId, ts, ts + ttlSeconds).run();
}

/** Returns the user id if the token is valid and unused, and marks it used. */
export async function consumeResetToken(env, tokenHash) {
  const row = await env.DB.prepare(
    'SELECT user_id FROM password_reset_tokens WHERE id = ? AND used = 0 AND expires_at > ?'
  ).bind(tokenHash, now()).first();
  if (!row) return null;
  await env.DB.prepare('UPDATE password_reset_tokens SET used = 1 WHERE id = ?').bind(tokenHash).run();
  return row.user_id;
}

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------
//
// Two kinds of account use this portal.
//
//   An agency owner is an admin. They see every advisor's reservations,
//   payments and production, and can break any report down by advisor. An
//   independent advisor working alone is also an admin, where "everyone"
//   happens to be just them, so the same code covers both without a setting.
//
//   An advisor associate sees their own records and nothing else.
//
// The scope is always derived from the signed in user. An advisor id in the
// query string is honoured only when the caller is an admin, so asking for
// someone else's data is not a matter of editing a URL.

/** Resolves what the signed in user may see. */
export function visibilityScope(env, user, advisorId = null) {
  const locationId = user.ghl_location_id || env.GHL_DEFAULT_LOCATION_ID || '';
  if (user.role !== 'admin') return { all: false, userId: user.id, locationId, self: true };
  if (advisorId && advisorId !== 'all') {
    return { all: false, userId: advisorId, locationId, self: advisorId === user.id };
  }
  return { all: true, locationId, self: false };
}

/** The scope for a request, honouring ?advisor= only for admins. */
export function scopeFor(env, user, request) {
  const advisorId = new URL(request.url).searchParams.get('advisor');
  return visibilityScope(env, user, advisorId);
}

/**
 * This user and no one else, whatever their role.
 *
 * Every write goes through one of these. An owner may see an advisor's
 * reservation; that is not the same as writing to it, and using the viewing
 * scope on a write is how the two would quietly become one permission.
 */
export function selfScope(user) {
  return { all: false, userId: user.id, self: true };
}

/**
 * How the UI should describe the current scope.
 *
 * Every screen that can show more than your own records says whose they are.
 * A total that silently covers the whole agency looks exactly like a total
 * that covers you, and the difference is the whole point of the number.
 */
export function scopeLabel(scope, user) {
  if (scope.all) return { all: true, advisorId: null, label: 'All advisors', canPick: user.role === 'admin' };
  if (scope.self) return { all: false, advisorId: user.id, label: 'Just me', canPick: user.role === 'admin' };
  return { all: false, advisorId: scope.userId, label: 'One advisor', canPick: user.role === 'admin' };
}

/**
 * The advisors an owner may narrow a screen to. Empty for an associate, whose
 * only scope is themselves, so the picker never appears for them.
 */
export async function advisorOptions(env, user) {
  if (user.role !== 'admin') return [];
  const users = await listUsers(env, {});
  return users
    .filter((u) => u.status === 'active')
    .map((u) => ({
      id: u.id,
      name: [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email,
      role: u.role,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The scope as a WHERE fragment plus its binds. */
export function scopeWhere(scope, column = 'user_id') {
  if (!scope.all) return { sql: `${column} = ?`, binds: [scope.userId] };
  // Every advisor bound to this agency. Written as a subquery rather than a
  // list of ids so it stays one statement however many advisors there are,
  // and so an advisor added mid-request cannot fall outside it.
  return {
    sql: `${column} IN (SELECT id FROM users WHERE COALESCE(ghl_location_id, ?) = ?)`,
    binds: [scope.locationId, scope.locationId],
  };
}

// ---------------------------------------------------------------------------
// Bookings
// ---------------------------------------------------------------------------
// Falls back to the email so a row is never attributed to nobody.
const ADVISOR_NAME =
  "COALESCE(NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), ''), u.email) AS advisor_name";

const BOOKING_COLUMNS = `
  id, user_id, ghl_contact_id, ghl_opportunity_id, client_name, supplier,
  product_type, product_name, destination, confirmation_number, depart_date,
  return_date, deposit_due, final_payment_due, travellers, gross_cents, deposit_cents,
  commission_cents, commission_status, status, notes, group_id, created_at, updated_at
`;

// The same columns qualified, for the list query that joins users to name the
// advisor. Spelled out rather than derived from the line above: `status` and
// `id` exist on both tables, and an unqualified one is an error waiting to
// happen rather than a clever saving.
const BOOKING_COLUMNS_B = `
  b.id, b.user_id, b.ghl_contact_id, b.ghl_opportunity_id, b.client_name, b.supplier,
  b.product_type, b.product_name, b.destination, b.confirmation_number, b.depart_date,
  b.return_date, b.deposit_due, b.final_payment_due, b.travellers, b.gross_cents,
  b.deposit_cents, b.commission_cents, b.commission_status, b.status, b.notes,
  b.group_id, b.created_at, b.updated_at
`;

export async function listBookings(env, scope, { status, search, limit = 200 } = {}) {
  const scoped = scopeWhere(scope, 'b.user_id');
  const where = [scoped.sql];
  const binds = [...scoped.binds];
  if (status) { where.push('b.status = ?'); binds.push(status); }
  if (search) {
    where.push('(b.client_name LIKE ? OR b.supplier LIKE ? OR b.product_name LIKE ? OR b.confirmation_number LIKE ?)');
    const like = `%${search}%`;
    binds.push(like, like, like, like);
  }
  binds.push(Math.min(Number(limit) || 200, 500));
  const { results } = await env.DB.prepare(
    `SELECT ${BOOKING_COLUMNS_B}, ${ADVISOR_NAME}
       FROM bookings b LEFT JOIN users u ON u.id = b.user_id
      WHERE ${where.join(' AND ')}
      ORDER BY COALESCE(b.depart_date, '9999-12-31') ASC, b.created_at DESC
      LIMIT ?`
  ).bind(...binds).all();
  return results || [];
}

export async function getBooking(env, id, userId) {
  return env.DB.prepare(
    `SELECT ${BOOKING_COLUMNS} FROM bookings WHERE id = ? AND user_id = ?`
  ).bind(id, userId).first();
}

export async function createBooking(env, userId, f) {
  const ts = now();
  const id = uid();
  await env.DB.prepare(
    `INSERT INTO bookings
       (id, user_id, ghl_contact_id, ghl_opportunity_id, client_name, supplier,
        product_type, product_name, destination, confirmation_number,
        depart_date, return_date, deposit_due, final_payment_due, travellers,
        gross_cents, deposit_cents, commission_cents, commission_status, status, notes,
        group_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id, userId, f.ghlContactId || null, f.ghlOpportunityId || null,
    f.clientName, f.supplier || null, f.productType, f.productName || null,
    f.destination || null, f.confirmationNumber || null,
    f.departDate, f.returnDate, f.depositDue, f.finalPaymentDue,
    f.travellers, f.grossCents, f.depositCents || 0, f.commissionCents, f.commissionStatus,
    f.status, f.notes || null, f.groupId || null, ts, ts
  ).run();
  return getBooking(env, id, userId);
}

export async function updateBooking(env, id, userId, f) {
  const res = await env.DB.prepare(
    `UPDATE bookings SET
       ghl_contact_id = ?, ghl_opportunity_id = ?, client_name = ?, supplier = ?,
       product_type = ?, product_name = ?, destination = ?, confirmation_number = ?,
       depart_date = ?, return_date = ?, deposit_due = ?, final_payment_due = ?,
       travellers = ?, gross_cents = ?, deposit_cents = ?, commission_cents = ?, commission_status = ?,
       status = ?, notes = ?, group_id = ?, updated_at = ?
     WHERE id = ? AND user_id = ?`
  ).bind(
    f.ghlContactId || null, f.ghlOpportunityId || null, f.clientName, f.supplier || null,
    f.productType, f.productName || null, f.destination || null, f.confirmationNumber || null,
    f.departDate, f.returnDate, f.depositDue, f.finalPaymentDue,
    f.travellers, f.grossCents, f.depositCents || 0, f.commissionCents, f.commissionStatus,
    f.status, f.notes || null, f.groupId || null, now(), id, userId
  ).run();
  if (!res.meta || res.meta.changes === 0) return null;
  return getBooking(env, id, userId);
}

export async function deleteBooking(env, id, userId) {
  const res = await env.DB.prepare('DELETE FROM bookings WHERE id = ? AND user_id = ?')
    .bind(id, userId).run();
  return Boolean(res.meta && res.meta.changes > 0);
}

/** Headline numbers for the dashboard and the reports page. */
export async function bookingStats(env, scope) {
  const scoped = scopeWhere(scope);
  const row = await env.DB.prepare(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status = 'booked' THEN 1 ELSE 0 END) AS booked,
       SUM(CASE WHEN status = 'quoted' THEN 1 ELSE 0 END) AS quoted,
       SUM(CASE WHEN status = 'travelled' THEN 1 ELSE 0 END) AS travelled,
       SUM(CASE WHEN status IN ('booked','travelled') THEN gross_cents ELSE 0 END) AS gross_cents,
       SUM(CASE WHEN status IN ('booked','travelled') THEN commission_cents ELSE 0 END) AS commission_cents,
       SUM(CASE WHEN commission_status = 'paid' THEN commission_cents ELSE 0 END) AS commission_paid_cents
     FROM bookings WHERE ${scoped.sql}`
  ).bind(...scoped.binds).first();
  return {
    total: row?.total || 0,
    booked: row?.booked || 0,
    quoted: row?.quoted || 0,
    travelled: row?.travelled || 0,
    grossCents: row?.gross_cents || 0,
    commissionCents: row?.commission_cents || 0,
    commissionPaidCents: row?.commission_paid_cents || 0,
  };
}

/**
 * Payments falling due on or before `through`, newest deadline first.
 *
 * Reads the payment schedule rather than the booking's own date columns. Those
 * columns say when a deadline is, not whether it has been met, so a dashboard
 * built on them keeps showing money as due after it has been paid.
 */
export async function upcomingPayments(env, scope, through) {
  const scoped = scopeWhere(scope, 'p.user_id');
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.kind, p.payment_class, p.amount_cents, p.due_date,
            b.id AS booking_id, b.client_name, b.supplier, b.product_name,
            b.depart_date, b.status
       FROM booking_payments p
       JOIN bookings b ON b.id = p.booking_id
      WHERE ${scoped.sql}
        AND p.paid_date IS NULL
        AND p.due_date IS NOT NULL
        AND p.due_date <= ?
        AND b.status IN ('quoted','booked')
      ORDER BY p.due_date ASC
      LIMIT 50`
  ).bind(...scoped.binds, through).all();
  return results || [];
}

/** Gross and commission grouped by departure month, for the reports chart. */
export async function productionByMonth(env, scope, sinceDate) {
  const scoped = scopeWhere(scope);
  const { results } = await env.DB.prepare(
    `SELECT substr(depart_date, 1, 7) AS month,
            COUNT(*) AS bookings,
            SUM(gross_cents) AS gross_cents,
            SUM(commission_cents) AS commission_cents
       FROM bookings
      WHERE ${scoped.sql} AND depart_date IS NOT NULL AND depart_date >= ?
        AND status IN ('booked','travelled')
      GROUP BY month ORDER BY month ASC LIMIT 36`
  ).bind(...scoped.binds, sinceDate).all();
  return results || [];
}

// ---------------------------------------------------------------------------
// Activity log
// ---------------------------------------------------------------------------
/**
 * Production broken down by advisor, for an owner looking at the agency.
 *
 * Active advisors with nothing booked still appear, at zero. An owner asking
 * who is producing needs to see the quiet ones, and a report that silently
 * omits them answers a different question from the one being asked.
 *
 * A suspended advisor appears only if they produced something in the window.
 * Their past production is real and belongs in the total, but a row of zeros
 * for someone who no longer works here is noise, not information.
 */
export async function productionByAdvisor(env, scope, sinceDate) {
  const scoped = scopeWhere(scope, 'u.id');
  const { results } = await env.DB.prepare(
    `SELECT u.id AS user_id, ${ADVISOR_NAME}, u.role, u.status,
            COUNT(b.id) AS bookings,
            COALESCE(SUM(b.gross_cents), 0) AS gross_cents,
            COALESCE(SUM(b.commission_cents), 0) AS commission_cents,
            COALESCE(SUM(CASE WHEN b.commission_status = 'paid' THEN b.commission_cents END), 0)
              AS commission_paid_cents
       FROM users u
       LEFT JOIN bookings b
         ON b.user_id = u.id
        AND b.status IN ('booked','travelled')
        AND b.depart_date IS NOT NULL AND b.depart_date >= ?
      WHERE ${scoped.sql} AND u.status != 'pending'
      GROUP BY u.id
      HAVING u.status = 'active' OR COUNT(b.id) > 0
      ORDER BY gross_cents DESC, advisor_name ASC`
  ).bind(sinceDate, ...scoped.binds).all();
  return results || [];
}

/**
 * One reservation, readable by anyone whose scope covers it.
 *
 * Deliberately separate from getBooking, which stays scoped to the owner
 * because every write goes through it. Seeing an advisor's reservation and
 * editing it are different permissions, and merging the two lookups is how
 * they would quietly become the same one.
 */
export async function getBookingInScope(env, id, scope) {
  const scoped = scopeWhere(scope, 'b.user_id');
  return env.DB.prepare(
    `SELECT ${BOOKING_COLUMNS_B}, ${ADVISOR_NAME}
       FROM bookings b LEFT JOIN users u ON u.id = b.user_id
      WHERE b.id = ? AND ${scoped.sql}`
  ).bind(id, ...scoped.binds).first();
}

/**
 * Booked value split by what was sold, and by whom it was sold through.
 *
 * Two questions an owner actually asks: what mix are we selling, and which
 * vendors are we sending business to. Both are one grouped query, so they are
 * one function with the grouping column chosen rather than two near copies.
 */
export async function productionBreakdown(env, scope, sinceDate, by = 'type') {
  const column = by === 'vendor' ? "COALESCE(NULLIF(supplier, ''), 'Unrecorded')" : 'product_type';
  const scoped = scopeWhere(scope);
  const { results } = await env.DB.prepare(
    `SELECT ${column} AS label,
            COUNT(*) AS bookings,
            SUM(gross_cents) AS gross_cents,
            SUM(commission_cents) AS commission_cents
       FROM bookings
      WHERE ${scoped.sql} AND depart_date IS NOT NULL AND depart_date >= ?
        AND status IN ('booked','travelled')
      GROUP BY label ORDER BY gross_cents DESC LIMIT 20`
  ).bind(...scoped.binds, sinceDate).all();
  return results || [];
}

/**
 * Clients worth ringing: they have travelled with you and have nothing booked.
 *
 * The most reliable rebooking signal an agency has, and the one nobody acts on
 * because it is invisible. A client who came back from a cruise eleven months
 * ago and has nothing on the books is not a lapsed client yet; they are a
 * client about to book with somebody else.
 *
 * Matched on client name rather than a contact id, because reservations are
 * often entered before the CRM record exists and the name is the only thing
 * both records reliably share.
 */
export async function rebookCandidates(env, scope, { today, limit = 25 } = {}) {
  const scoped = scopeWhere(scope, 'b.user_id');
  const { results } = await env.DB.prepare(
    `SELECT b.client_name,
            MAX(COALESCE(b.return_date, b.depart_date)) AS last_travelled,
            COUNT(*) AS trips,
            SUM(b.gross_cents) AS lifetime_cents,
            MAX(b.supplier) AS last_vendor
       FROM bookings b
      WHERE ${scoped.sql}
        AND b.status IN ('booked','travelled')
        AND COALESCE(b.return_date, b.depart_date) IS NOT NULL
        AND COALESCE(b.return_date, b.depart_date) < ?
      GROUP BY b.client_name
      HAVING NOT EXISTS (
        SELECT 1 FROM bookings f
         WHERE f.client_name = b.client_name
           AND f.user_id = b.user_id
           AND f.status IN ('quoted','booked')
           AND COALESCE(f.return_date, f.depart_date) >= ?)
      ORDER BY last_travelled DESC LIMIT ?`
  ).bind(...scoped.binds, today, today, Math.min(Number(limit) || 25, 100)).all();
  return results || [];
}

/**
 * Everything with a date on it, for one month.
 *
 * Departures, returns, vendor deadlines, own reminders, task due dates and the
 * day a group's unsold space goes back. Six queries rather than one union so
 * each keeps its own columns and its own scope column, and because a union of
 * six differently shaped tables is unreadable a month after writing it.
 *
 * Read only and cheap: each is an indexed range scan over one month.
 */
export async function calendarMonth(env, scope, { from, to }) {
  const b = scopeWhere(scope, 'b.user_id');
  const p = scopeWhere(scope, 'p.user_id');
  const t = scopeWhere(scope, 't.user_id');
  const g = scopeWhere(scope, 'g.user_id');

  const [departs, returns, payments, tasks, options] = await Promise.all([
    env.DB.prepare(
      `SELECT b.id, b.depart_date AS on_date, b.client_name, b.supplier
         FROM bookings b WHERE ${b.sql} AND b.status IN ('quoted','booked','travelled')
          AND b.depart_date BETWEEN ? AND ?`
    ).bind(...b.binds, from, to).all().catch(() => ({ results: [] })),

    env.DB.prepare(
      `SELECT b.id, b.return_date AS on_date, b.client_name, b.supplier
         FROM bookings b WHERE ${b.sql} AND b.status IN ('quoted','booked','travelled')
          AND b.return_date BETWEEN ? AND ?`
    ).bind(...b.binds, from, to).all().catch(() => ({ results: [] })),

    env.DB.prepare(
      `SELECT p.id, p.due_date AS on_date, p.payment_class, p.kind, p.amount_cents,
              b.client_name, b.supplier
         FROM booking_payments p JOIN bookings b ON b.id = p.booking_id
        WHERE ${p.sql} AND p.paid_date IS NULL AND p.due_date BETWEEN ? AND ?`
    ).bind(...p.binds, from, to).all().catch(() => ({ results: [] })),

    env.DB.prepare(
      `SELECT t.id, t.due_date AS on_date, t.title, t.priority
         FROM tasks t WHERE ${t.sql} AND t.done_at IS NULL AND t.due_date BETWEEN ? AND ?`
    ).bind(...t.binds, from, to).all().catch(() => ({ results: [] })),

    env.DB.prepare(
      `SELECT g.id, g.option_date AS on_date, g.name, g.vendor, g.cabins_held,
              (SELECT COUNT(*) FROM bookings x WHERE x.group_id = g.id
                AND x.status IN ('quoted','booked','travelled')) AS cabins_sold
         FROM travel_groups g WHERE ${g.sql} AND g.status = 'open'
          AND g.option_date BETWEEN ? AND ?`
    ).bind(...g.binds, from, to).all().catch(() => ({ results: [] })),
  ]);

  const out = [];
  for (const r of departs.results || []) {
    out.push({ date: r.on_date, kind: 'depart', title: r.client_name,
               detail: `Departs${r.supplier ? ' · ' + r.supplier : ''}`, href: '/app/reservations?focus=' + r.id });
  }
  for (const r of returns.results || []) {
    out.push({ date: r.on_date, kind: 'return', title: r.client_name,
               detail: `Returns${r.supplier ? ' · ' + r.supplier : ''}`, href: '/app/reservations?focus=' + r.id });
  }
  for (const r of payments.results || []) {
    out.push({ date: r.on_date, kind: r.payment_class === 'hard' ? 'hard' : 'soft',
               title: r.client_name, amountCents: r.amount_cents,
               detail: r.payment_class === 'hard' ? `${r.kind} due to vendor` : `chase ${r.kind}`,
               href: '/app/payments' });
  }
  for (const r of tasks.results || []) {
    out.push({ date: r.on_date, kind: 'task', title: r.title,
               detail: r.priority === 'high' ? 'high priority' : 'task', href: '/app/tasks' });
  }
  for (const r of options.results || []) {
    const left = Math.max(0, (r.cabins_held || 0) - (r.cabins_sold || 0));
    out.push({ date: r.on_date, kind: 'option', title: r.name,
               detail: `${left} unsold cabin${left === 1 ? '' : 's'} released`, href: '/app/groups' });
  }

  out.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
  return out;
}

export async function logActivity(env, userId, kind, subject, meta = null) {
  try {
    await env.DB.prepare(
      'INSERT INTO activity_log (id, user_id, kind, subject, meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(uid(), userId, kind, subject || null, meta ? JSON.stringify(meta) : null, now()).run();
  } catch (e) {
    // Activity logging must never break the request that triggered it.
    console.error('logActivity', e);
  }
}

export async function recentActivity(env, scope, limit = 15) {
  const scoped = scopeWhere(scope);
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.kind, a.subject, a.created_at, ${ADVISOR_NAME}
       FROM activity_log a LEFT JOIN users u ON u.id = a.user_id
      WHERE ${scopeWhere(scope, 'a.user_id').sql}
      ORDER BY a.created_at DESC LIMIT ?`
  ).bind(...scoped.binds, Math.min(Number(limit) || 15, 100)).all();
  return results || [];
}

// ---------------------------------------------------------------------------
// Local CRM mirror
//
// Reads come from here rather than the upstream API, so a list renders in a
// few milliseconds and keeps rendering when the upstream is rate limiting or
// down. The sync module keeps these current.
// ---------------------------------------------------------------------------
function hydrateContact(row) {
  if (!row) return null;
  let tags = [];
  try { tags = row.tags_json ? JSON.parse(row.tags_json) : []; } catch { tags = []; }
  return {
    id: row.id,
    name: row.name || [row.first_name, row.last_name].filter(Boolean).join(' ') || row.email || 'Unnamed contact',
    firstName: row.first_name || '',
    lastName: row.last_name || '',
    email: row.email || '',
    phone: row.phone || '',
    source: row.source || '',
    tags: Array.isArray(tags) ? tags : [],
    assignedTo: row.assigned_to || null,
    city: row.city || '',
    state: row.state || '',
    country: row.country || '',
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

export async function localContacts(env, locationId, { query, limit = 50, offset = 0 } = {}) {
  const where = ['location_id = ?'];
  const binds = [locationId];
  if (query) {
    where.push('(name LIKE ?1x OR email LIKE ?1x OR phone LIKE ?1x)'.replace(/\?1x/g, '?'));
    const like = `%${query}%`;
    binds.push(like, like, like);
  }
  const cap = Math.min(Number(limit) || 50, 200);
  const { results } = await env.DB.prepare(
    `SELECT * FROM crm_contacts WHERE ${where.join(' AND ')}
      ORDER BY COALESCE(created_at, '') DESC LIMIT ? OFFSET ?`
  ).bind(...binds, cap, Number(offset) || 0).all();

  const countRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM crm_contacts WHERE ${where.join(' AND ')}`
  ).bind(...binds).first();

  return { contacts: (results || []).map(hydrateContact), total: countRow?.n || 0 };
}

export async function localContact(env, id) {
  return hydrateContact(await env.DB.prepare('SELECT * FROM crm_contacts WHERE id = ?').bind(id).first());
}

export async function localPipelines(env, locationId) {
  const { results } = await env.DB.prepare(
    'SELECT * FROM crm_pipelines WHERE location_id = ? ORDER BY name'
  ).bind(locationId).all();
  return (results || []).map((r) => {
    let stages = [];
    try { stages = r.stages_json ? JSON.parse(r.stages_json) : []; } catch { stages = []; }
    return { id: r.id, name: r.name || 'Pipeline', stages };
  });
}

export async function localOpportunities(env, locationId, { pipelineId, status, query } = {}) {
  const where = ['location_id = ?'];
  const binds = [locationId];
  if (pipelineId) { where.push('pipeline_id = ?'); binds.push(pipelineId); }
  if (status) { where.push('status = ?'); binds.push(status); }
  if (query) {
    where.push('(name LIKE ? OR contact_name LIKE ?)');
    const like = `%${query}%`;
    binds.push(like, like);
  }
  const { results } = await env.DB.prepare(
    `SELECT * FROM crm_opportunities WHERE ${where.join(' AND ')}
      ORDER BY COALESCE(updated_at, created_at, '') DESC LIMIT 500`
  ).bind(...binds).all();
  return (results || []).map((r) => ({
    id: r.id,
    name: r.name || 'Untitled opportunity',
    status: r.status || '',
    stageId: r.stage_id || null,
    pipelineId: r.pipeline_id || null,
    monetaryValue: Number(r.monetary_value || 0),
    contactId: r.contact_id || null,
    contactName: r.contact_name || '',
    contactEmail: r.contact_email || '',
    contactPhone: r.contact_phone || '',
    assignedTo: r.assigned_to || null,
    source: r.source || '',
    createdAt: r.created_at || null,
    updatedAt: r.updated_at || null,
  }));
}

export async function localOpportunitiesForContact(env, contactId) {
  const { results } = await env.DB.prepare(
    'SELECT * FROM crm_opportunities WHERE contact_id = ? ORDER BY COALESCE(updated_at, "") DESC LIMIT 50'
  ).bind(contactId).all();
  return (results || []).map((r) => ({
    id: r.id, name: r.name || 'Untitled opportunity', status: r.status || '',
    monetaryValue: Number(r.monetary_value || 0), contactId: r.contact_id,
  }));
}

/**
 * How opportunities finished, for a closing rate.
 *
 * The rate counts won against won plus lost. Abandoned deals are reported but
 * kept out of the denominator: a lead that went quiet was never a decision,
 * and folding it in makes an advisor who chases plenty of cold leads look
 * worse than one who chases none.
 */
export async function localOpportunityOutcomes(env, locationId, sinceIso) {
  const { results } = await env.DB.prepare(
    `SELECT status, COUNT(*) AS n, COALESCE(SUM(monetary_value), 0) AS value
       FROM crm_opportunities
      WHERE location_id = ? AND status IS NOT NULL AND status != 'open'
        AND COALESCE(updated_at, created_at, '') >= ?
      GROUP BY status`
  ).bind(locationId, sinceIso).all().catch(() => ({ results: [] }));

  const by = Object.fromEntries((results || []).map((r) => [r.status, r]));
  const won = by.won?.n || 0;
  const lost = by.lost?.n || 0;
  const decided = won + lost;
  return {
    won,
    lost,
    abandoned: by.abandoned?.n || 0,
    wonValue: by.won?.value || 0,
    closingRate: decided > 0 ? Math.round((won / decided) * 1000) / 10 : null,
  };
}

export async function crmCounts(env, locationId) {
  const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM crm_contacts WHERE location_id = ?').bind(locationId).first();
  const o = await env.DB.prepare('SELECT COUNT(*) AS n FROM crm_opportunities WHERE location_id = ?').bind(locationId).first();
  const p = await env.DB.prepare('SELECT COUNT(*) AS n FROM crm_pipelines WHERE location_id = ?').bind(locationId).first();
  return { contacts: c?.n || 0, opportunities: o?.n || 0, pipelines: p?.n || 0 };
}

// ---------------------------------------------------------------------------
// Booking payments
//
// One row covers both sides of a payment: due_date with no paid_date is money
// expected, and the same row gains paid_date when it arrives.
// ---------------------------------------------------------------------------
const PAYMENT_COLUMNS = `
  p.id, p.booking_id, p.user_id, p.kind, p.payment_class, p.amount_cents,
  p.due_date, p.paid_date, p.method, p.reference, p.notes, p.created_at, p.updated_at
`;

export async function listPayments(env, scope, { bookingId, state, paymentClass, limit = 300 } = {}) {
  const scoped = scopeWhere(scope, 'p.user_id');
  const where = [scoped.sql];
  const binds = [...scoped.binds];
  if (bookingId) { where.push('p.booking_id = ?'); binds.push(bookingId); }
  if (state === 'outstanding') where.push('p.paid_date IS NULL');
  if (state === 'paid') where.push('p.paid_date IS NOT NULL');
  if (paymentClass) { where.push('p.payment_class = ?'); binds.push(paymentClass); }

  const { results } = await env.DB.prepare(
    `SELECT ${PAYMENT_COLUMNS},
            b.client_name, b.supplier, b.product_name, b.depart_date, b.status AS booking_status,
            ${ADVISOR_NAME}
       FROM booking_payments p
       JOIN bookings b ON b.id = p.booking_id
       LEFT JOIN users u ON u.id = p.user_id
      WHERE ${where.join(' AND ')}
      ORDER BY COALESCE(p.due_date, '9999-12-31') ASC, p.created_at ASC
      LIMIT ?`
  ).bind(...binds, Math.min(Number(limit) || 300, 500)).all();
  return results || [];
}

export async function getPayment(env, id, userId) {
  return env.DB.prepare(
    `SELECT ${PAYMENT_COLUMNS} FROM booking_payments p WHERE p.id = ? AND p.user_id = ?`
  ).bind(id, userId).first();
}

export async function createPayment(env, userId, f) {
  const ts = now();
  const id = uid();
  await env.DB.prepare(
    `INSERT INTO booking_payments
       (id, booking_id, user_id, kind, payment_class, amount_cents, due_date,
        paid_date, method, reference, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, f.bookingId, userId, f.kind, f.paymentClass || 'hard', f.amountCents,
         f.dueDate, f.paidDate, f.method || null, f.reference || null,
         f.notes || null, ts, ts).run();
  return getPayment(env, id, userId);
}

export async function updatePayment(env, id, userId, f) {
  const res = await env.DB.prepare(
    `UPDATE booking_payments
        SET kind = ?, payment_class = ?, amount_cents = ?, due_date = ?, paid_date = ?,
            method = ?, reference = ?, notes = ?, updated_at = ?
      WHERE id = ? AND user_id = ?`
  ).bind(f.kind, f.paymentClass || 'hard', f.amountCents, f.dueDate, f.paidDate,
         f.method || null, f.reference || null, f.notes || null, now(), id, userId).run();
  if (!res.meta || res.meta.changes === 0) return null;
  return getPayment(env, id, userId);
}

export async function deletePayment(env, id, userId) {
  const res = await env.DB.prepare('DELETE FROM booking_payments WHERE id = ? AND user_id = ?')
    .bind(id, userId).run();
  return Boolean(res.meta && res.meta.changes > 0);
}

/**
 * The numbers the payments page leads with, split the way the trade splits
 * them: soft, hard and past due.
 *
 * A hard payment is the vendor's deadline and missing it cancels the
 * reservation. A soft payment is the advisor's own earlier reminder, which is
 * the one that gives them room to collect. Reporting the two as one number
 * hides the only distinction that matters.
 */
/**
 * The money figures behind the Payments screen and the dashboard.
 *
 * Hard and soft get their own windows because they answer different
 * questions. A hard date is the vendor's deadline, so the useful horizon is
 * how much could cancel shortly. A soft date is your own reminder to chase,
 * which is only worth surfacing while there is still time to act on it: a
 * fortnight of reminders is a list, a week of them is a plan.
 */
export async function paymentStats(env, scope, { today, soonThrough, softThrough }) {
  const softEnd = softThrough || soonThrough;
  const scoped = scopeWhere(scope);
  const row = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN paid_date IS NOT NULL THEN amount_cents ELSE 0 END) AS posted,
       SUM(CASE WHEN paid_date IS NULL THEN amount_cents ELSE 0 END) AS outstanding,
       SUM(CASE WHEN paid_date IS NULL AND due_date IS NOT NULL AND due_date < ?
                THEN amount_cents ELSE 0 END) AS past_due,
       SUM(CASE WHEN paid_date IS NULL AND due_date IS NOT NULL AND due_date < ?
                THEN 1 ELSE 0 END) AS past_due_count,
       SUM(CASE WHEN paid_date IS NULL AND payment_class = 'soft'
                     AND due_date IS NOT NULL AND due_date >= ? AND due_date <= ?
                THEN amount_cents ELSE 0 END) AS soft_due,
       SUM(CASE WHEN paid_date IS NULL AND payment_class = 'soft'
                     AND due_date IS NOT NULL AND due_date >= ? AND due_date <= ?
                THEN 1 ELSE 0 END) AS soft_count,
       SUM(CASE WHEN paid_date IS NULL AND payment_class = 'hard'
                     AND due_date IS NOT NULL AND due_date >= ? AND due_date <= ?
                THEN amount_cents ELSE 0 END) AS hard_due,
       SUM(CASE WHEN paid_date IS NULL AND payment_class = 'hard'
                     AND due_date IS NOT NULL AND due_date >= ? AND due_date <= ?
                THEN 1 ELSE 0 END) AS hard_count
     FROM booking_payments WHERE ${scoped.sql}`
  ).bind(today, today, today, softEnd, today, softEnd,
         today, soonThrough, today, soonThrough, ...scoped.binds).first();

  return {
    postedCents: row?.posted || 0,
    outstandingCents: row?.outstanding || 0,
    pastDueCents: row?.past_due || 0,
    pastDueCount: row?.past_due_count || 0,
    softDueCents: row?.soft_due || 0,
    softCount: row?.soft_count || 0,
    hardDueCents: row?.hard_due || 0,
    hardCount: row?.hard_count || 0,
  };
}

/** Per-booking balance: what it is worth, what came in, what is left. */
export async function bookingBalances(env, scope) {
  const scoped = scopeWhere(scope, 'b.user_id');
  const { results } = await env.DB.prepare(
    `SELECT b.id, b.client_name, b.supplier, b.product_name, b.depart_date,
            b.status, b.gross_cents, b.deposit_cents,
            COALESCE(SUM(CASE WHEN p.paid_date IS NOT NULL THEN p.amount_cents END), 0) AS paid_cents,
            COALESCE(SUM(CASE WHEN p.paid_date IS NULL THEN p.amount_cents END), 0) AS scheduled_cents,
            COUNT(p.id) AS payment_count
       FROM bookings b
       LEFT JOIN booking_payments p ON p.booking_id = b.id
      WHERE ${scoped.sql} AND b.status IN ('quoted','booked','travelled')
      GROUP BY b.id
      ORDER BY COALESCE(b.depart_date, '9999-12-31') ASC
      LIMIT 200`
  ).bind(...scoped.binds).all();
  return results || [];
}

/**
 * Client payments grouped by the month they are due, split into what has been
 * posted and what is still outstanding.
 *
 * Reports previously answered only "what did I sell". This answers "what is
 * landing when", which is the question that decides whether a booking survives
 * its supplier deadline.
 */
export async function paymentsByMonth(env, scope, sinceDate) {
  const scoped = scopeWhere(scope, 'p.user_id');
  const { results } = await env.DB.prepare(
    `SELECT substr(p.due_date, 1, 7) AS month,
            COUNT(*) AS payments,
            SUM(CASE WHEN p.paid_date IS NOT NULL THEN p.amount_cents ELSE 0 END) AS posted_cents,
            SUM(CASE WHEN p.paid_date IS NULL THEN p.amount_cents ELSE 0 END) AS outstanding_cents
       FROM booking_payments p
       JOIN bookings b ON b.id = p.booking_id
      WHERE ${scoped.sql} AND p.due_date IS NOT NULL AND p.due_date >= ?
        AND b.status IN ('quoted','booked','travelled')
      GROUP BY month ORDER BY month ASC LIMIT 36`
  ).bind(...scoped.binds, sinceDate).all();
  return results || [];
}

/**
 * Recent reservation activity: what was added or last touched.
 * Mirrors the widget an advisor is used to reading first thing.
 */
export async function recentReservations(env, scope, { by = 'added', limit = 8 } = {}) {
  const order = by === 'modified' ? 'b.updated_at DESC' : 'b.created_at DESC';
  const scoped = scopeWhere(scope, 'b.user_id');
  const { results } = await env.DB.prepare(
    `SELECT b.id, b.client_name, b.supplier, b.product_name, b.depart_date,
            b.return_date, b.confirmation_number, b.status, b.gross_cents,
            b.created_at, b.updated_at, ${ADVISOR_NAME}
       FROM bookings b LEFT JOIN users u ON u.id = b.user_id
      WHERE ${scoped.sql} AND b.status != 'cancelled'
      ORDER BY ${order} LIMIT ?`
  ).bind(...scoped.binds, Math.min(Number(limit) || 8, 25)).all();
  return results || [];
}

/**
 * Current reservation activity: departing soon, away right now, or just back.
 * Recently returned is the one that drives follow-up and reviews.
 */
export async function currentReservations(env, scope, { view = 'upcoming', today, limit = 8 } = {}) {
  let clause;
  let order;
  if (view === 'traveling') {
    clause = "b.depart_date <= ? AND COALESCE(b.return_date, b.depart_date) >= ?";
    order = 'b.depart_date ASC';
  } else if (view === 'returned') {
    clause = "COALESCE(b.return_date, b.depart_date) < ? AND COALESCE(b.return_date, b.depart_date) >= date(?, '-45 days')";
    order = 'COALESCE(b.return_date, b.depart_date) DESC';
  } else {
    clause = "b.depart_date >= ? AND ? IS NOT NULL";
    order = 'b.depart_date ASC';
  }
  const scoped = scopeWhere(scope, 'b.user_id');
  const { results } = await env.DB.prepare(
    `SELECT b.id, b.client_name, b.supplier, b.product_name, b.depart_date,
            b.return_date, b.confirmation_number, b.status, ${ADVISOR_NAME}
       FROM bookings b LEFT JOIN users u ON u.id = b.user_id
      WHERE ${scoped.sql} AND b.status IN ('booked','travelled') AND b.depart_date IS NOT NULL
        AND ${clause}
      ORDER BY ${order} LIMIT ?`
  ).bind(...scoped.binds, today, today, Math.min(Number(limit) || 8, 25)).all();
  return results || [];
}
