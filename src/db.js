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
// Bookings
// ---------------------------------------------------------------------------
const BOOKING_COLUMNS = `
  id, user_id, ghl_contact_id, ghl_opportunity_id, client_name, supplier,
  product_type, product_name, destination, confirmation_number, depart_date,
  return_date, deposit_due, final_payment_due, travellers, gross_cents, deposit_cents,
  commission_cents, commission_status, status, notes, created_at, updated_at
`;

export async function listBookings(env, userId, { status, search, limit = 200 } = {}) {
  const where = ['user_id = ?'];
  const binds = [userId];
  if (status) { where.push('status = ?'); binds.push(status); }
  if (search) {
    where.push('(client_name LIKE ? OR supplier LIKE ? OR product_name LIKE ? OR confirmation_number LIKE ?)');
    const like = `%${search}%`;
    binds.push(like, like, like, like);
  }
  binds.push(Math.min(Number(limit) || 200, 500));
  const { results } = await env.DB.prepare(
    `SELECT ${BOOKING_COLUMNS} FROM bookings
      WHERE ${where.join(' AND ')}
      ORDER BY COALESCE(depart_date, '9999-12-31') ASC, created_at DESC
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
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id, userId, f.ghlContactId || null, f.ghlOpportunityId || null,
    f.clientName, f.supplier || null, f.productType, f.productName || null,
    f.destination || null, f.confirmationNumber || null,
    f.departDate, f.returnDate, f.depositDue, f.finalPaymentDue,
    f.travellers, f.grossCents, f.depositCents || 0, f.commissionCents, f.commissionStatus,
    f.status, f.notes || null, ts, ts
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
       status = ?, notes = ?, updated_at = ?
     WHERE id = ? AND user_id = ?`
  ).bind(
    f.ghlContactId || null, f.ghlOpportunityId || null, f.clientName, f.supplier || null,
    f.productType, f.productName || null, f.destination || null, f.confirmationNumber || null,
    f.departDate, f.returnDate, f.depositDue, f.finalPaymentDue,
    f.travellers, f.grossCents, f.depositCents || 0, f.commissionCents, f.commissionStatus,
    f.status, f.notes || null, now(), id, userId
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
export async function bookingStats(env, userId) {
  const row = await env.DB.prepare(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status = 'booked' THEN 1 ELSE 0 END) AS booked,
       SUM(CASE WHEN status = 'quoted' THEN 1 ELSE 0 END) AS quoted,
       SUM(CASE WHEN status = 'travelled' THEN 1 ELSE 0 END) AS travelled,
       SUM(CASE WHEN status IN ('booked','travelled') THEN gross_cents ELSE 0 END) AS gross_cents,
       SUM(CASE WHEN status IN ('booked','travelled') THEN commission_cents ELSE 0 END) AS commission_cents,
       SUM(CASE WHEN commission_status = 'paid' THEN commission_cents ELSE 0 END) AS commission_paid_cents
     FROM bookings WHERE user_id = ?`
  ).bind(userId).first();
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
export async function upcomingPayments(env, userId, through) {
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.kind, p.amount_cents, p.due_date,
            b.id AS booking_id, b.client_name, b.supplier, b.product_name,
            b.depart_date, b.status
       FROM booking_payments p
       JOIN bookings b ON b.id = p.booking_id
      WHERE p.user_id = ?
        AND p.paid_date IS NULL
        AND p.due_date IS NOT NULL
        AND p.due_date <= ?
        AND b.status IN ('quoted','booked')
      ORDER BY p.due_date ASC
      LIMIT 50`
  ).bind(userId, through).all();
  return results || [];
}

/** Gross and commission grouped by departure month, for the reports chart. */
export async function productionByMonth(env, userId, sinceDate) {
  const { results } = await env.DB.prepare(
    `SELECT substr(depart_date, 1, 7) AS month,
            COUNT(*) AS bookings,
            SUM(gross_cents) AS gross_cents,
            SUM(commission_cents) AS commission_cents
       FROM bookings
      WHERE user_id = ? AND depart_date IS NOT NULL AND depart_date >= ?
        AND status IN ('booked','travelled')
      GROUP BY month ORDER BY month ASC LIMIT 36`
  ).bind(userId, sinceDate).all();
  return results || [];
}

// ---------------------------------------------------------------------------
// Activity log
// ---------------------------------------------------------------------------
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

export async function recentActivity(env, userId, limit = 15) {
  const { results } = await env.DB.prepare(
    `SELECT id, kind, subject, created_at FROM activity_log
      WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`
  ).bind(userId, Math.min(Number(limit) || 15, 100)).all();
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
  p.id, p.booking_id, p.user_id, p.kind, p.amount_cents, p.due_date, p.paid_date,
  p.method, p.reference, p.notes, p.created_at, p.updated_at
`;

export async function listPayments(env, userId, { bookingId, state, limit = 300 } = {}) {
  const where = ['p.user_id = ?'];
  const binds = [userId];
  if (bookingId) { where.push('p.booking_id = ?'); binds.push(bookingId); }
  if (state === 'outstanding') where.push('p.paid_date IS NULL');
  if (state === 'paid') where.push('p.paid_date IS NOT NULL');

  const { results } = await env.DB.prepare(
    `SELECT ${PAYMENT_COLUMNS},
            b.client_name, b.supplier, b.product_name, b.depart_date, b.status AS booking_status
       FROM booking_payments p
       JOIN bookings b ON b.id = p.booking_id
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
       (id, booking_id, user_id, kind, amount_cents, due_date, paid_date, method,
        reference, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, f.bookingId, userId, f.kind, f.amountCents, f.dueDate, f.paidDate,
         f.method || null, f.reference || null, f.notes || null, ts, ts).run();
  return getPayment(env, id, userId);
}

export async function updatePayment(env, id, userId, f) {
  const res = await env.DB.prepare(
    `UPDATE booking_payments
        SET kind = ?, amount_cents = ?, due_date = ?, paid_date = ?, method = ?,
            reference = ?, notes = ?, updated_at = ?
      WHERE id = ? AND user_id = ?`
  ).bind(f.kind, f.amountCents, f.dueDate, f.paidDate, f.method || null,
         f.reference || null, f.notes || null, now(), id, userId).run();
  if (!res.meta || res.meta.changes === 0) return null;
  return getPayment(env, id, userId);
}

export async function deletePayment(env, id, userId) {
  const res = await env.DB.prepare('DELETE FROM booking_payments WHERE id = ? AND user_id = ?')
    .bind(id, userId).run();
  return Boolean(res.meta && res.meta.changes > 0);
}

/** The numbers the payments page leads with. */
export async function paymentStats(env, userId, { soonThrough, today }) {
  const row = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN paid_date IS NOT NULL THEN amount_cents ELSE 0 END) AS collected,
       SUM(CASE WHEN paid_date IS NULL THEN amount_cents ELSE 0 END) AS outstanding,
       SUM(CASE WHEN paid_date IS NULL AND due_date IS NOT NULL AND due_date < ?
                THEN amount_cents ELSE 0 END) AS overdue,
       SUM(CASE WHEN paid_date IS NULL AND due_date IS NOT NULL
                     AND due_date >= ? AND due_date <= ?
                THEN amount_cents ELSE 0 END) AS due_soon,
       SUM(CASE WHEN paid_date IS NULL AND due_date IS NOT NULL AND due_date < ?
                THEN 1 ELSE 0 END) AS overdue_count
     FROM booking_payments WHERE user_id = ?`
  ).bind(today, today, soonThrough, today, userId).first();

  return {
    collectedCents: row?.collected || 0,
    outstandingCents: row?.outstanding || 0,
    overdueCents: row?.overdue || 0,
    dueSoonCents: row?.due_soon || 0,
    overdueCount: row?.overdue_count || 0,
  };
}

/** Per-booking balance: what it is worth, what came in, what is left. */
export async function bookingBalances(env, userId) {
  const { results } = await env.DB.prepare(
    `SELECT b.id, b.client_name, b.supplier, b.product_name, b.depart_date,
            b.status, b.gross_cents, b.deposit_cents,
            COALESCE(SUM(CASE WHEN p.paid_date IS NOT NULL THEN p.amount_cents END), 0) AS paid_cents,
            COALESCE(SUM(CASE WHEN p.paid_date IS NULL THEN p.amount_cents END), 0) AS scheduled_cents,
            COUNT(p.id) AS payment_count
       FROM bookings b
       LEFT JOIN booking_payments p ON p.booking_id = b.id
      WHERE b.user_id = ? AND b.status IN ('quoted','booked','travelled')
      GROUP BY b.id
      ORDER BY COALESCE(b.depart_date, '9999-12-31') ASC
      LIMIT 200`
  ).bind(userId).all();
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
export async function paymentsByMonth(env, userId, sinceDate) {
  const { results } = await env.DB.prepare(
    `SELECT substr(p.due_date, 1, 7) AS month,
            COUNT(*) AS payments,
            SUM(CASE WHEN p.paid_date IS NOT NULL THEN p.amount_cents ELSE 0 END) AS posted_cents,
            SUM(CASE WHEN p.paid_date IS NULL THEN p.amount_cents ELSE 0 END) AS outstanding_cents
       FROM booking_payments p
       JOIN bookings b ON b.id = p.booking_id
      WHERE p.user_id = ? AND p.due_date IS NOT NULL AND p.due_date >= ?
        AND b.status IN ('quoted','booked','travelled')
      GROUP BY month ORDER BY month ASC LIMIT 36`
  ).bind(userId, sinceDate).all();
  return results || [];
}
