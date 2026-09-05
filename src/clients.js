// Everything about one client, assembled from what this portal owns.
//
// Deliberately built from reservations rather than from the CRM mirror. The
// CRM knows who someone is; this knows what they have bought, what they are
// owed, and when they last travelled, and it keeps working when the upstream
// API does not. A client who has never been synced but has three trips on file
// is still a client.
//
// Reservations are joined on the client's name, which is the only key both
// sides reliably share: a trip is often entered before the CRM record exists.
// That is a real weakness and worth stating plainly rather than hiding: two
// people with the same name would be merged here.

import { json, notFound, clean } from './util.js';
import { requireUser } from './auth.js';
import * as db from './db.js';

export async function handleClientRecord(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const url = new URL(request.url);
  const name = clean(url.searchParams.get('name'), 120);
  if (!name) return notFound('No client was named.');

  const scope = db.scopeFor(env, user, request);
  const bScope = db.scopeWhere(scope, 'b.user_id');
  const cScope = db.scopeWhere(scope, 'c.user_id');
  const tScope = db.scopeWhere(scope, 't.user_id');
  const today = new Date().toISOString().slice(0, 10);

  const [bookings, credits, tasks] = await Promise.all([
    env.DB.prepare(
      `SELECT b.id, b.client_name, b.supplier, b.product_name, b.product_type, b.destination,
              b.confirmation_number, b.depart_date, b.return_date, b.status,
              b.gross_cents, b.commission_cents, b.commission_status, b.travellers,
              b.ghl_contact_id, b.user_id,
              COALESCE(NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), ''), u.email)
                AS advisor_name
         FROM bookings b LEFT JOIN users u ON u.id = b.user_id
        WHERE ${bScope.sql} AND b.client_name = ?
        ORDER BY COALESCE(b.depart_date, '9999-12-31') DESC LIMIT 200`
    ).bind(...bScope.binds, name).all().catch(() => ({ results: [] })),

    env.DB.prepare(
      `SELECT c.id, c.vendor, c.kind, c.amount_cents, c.expires_on, c.used_on, c.reference
         FROM client_credits c WHERE ${cScope.sql} AND c.client_name = ?
        ORDER BY COALESCE(c.expires_on, '9999-12-31') ASC`
    ).bind(...cScope.binds, name).all().catch(() => ({ results: [] })),

    env.DB.prepare(
      `SELECT t.id, t.title, t.due_date, t.priority, t.done_at
         FROM tasks t JOIN bookings b ON b.id = t.booking_id
        WHERE ${tScope.sql} AND b.client_name = ?
        ORDER BY t.done_at IS NOT NULL ASC, COALESCE(t.due_date, '9999-12-31') ASC LIMIT 50`
    ).bind(...tScope.binds, name).all().catch(() => ({ results: [] })),
  ]);

  const rows = bookings.results || [];
  if (!rows.length) return notFound('No reservations for that client.');

  const counted = rows.filter((b) => b.status === 'booked' || b.status === 'travelled');
  const past = counted.filter((b) => (b.return_date || b.depart_date) < today);
  const upcoming = counted.filter((b) => (b.return_date || b.depart_date) >= today);
  const liveCredits = (credits.results || []).filter((c) => !c.used_on);

  // The contact id is taken from whichever reservation carries one, so a
  // client linked to the CRM on any trip is linked here.
  const contactId = rows.map((b) => b.ghl_contact_id).find(Boolean) || null;

  return json({
    client: {
      name,
      contactId,
      trips: counted.length,
      lifetimeCents: counted.reduce((n, b) => n + (b.gross_cents || 0), 0),
      commissionCents: counted.reduce((n, b) => n + (b.commission_cents || 0), 0),
      firstTravelled: past.length ? past[past.length - 1].depart_date : null,
      lastTravelled: past.length ? (past[0].return_date || past[0].depart_date) : null,
      // The one thing an advisor wants to know before they ring: is anything
      // already on the books.
      nextDeparture: upcoming.length
        ? upcoming[upcoming.length - 1].depart_date : null,
      vendors: [...new Set(counted.map((b) => b.supplier).filter(Boolean))],
      creditCents: liveCredits.reduce((n, c) => n + (c.amount_cents || 0), 0),
    },
    bookings: rows,
    credits: credits.results || [],
    tasks: tasks.results || [],
    today,
    scope: db.scopeLabel(scope, user),
  });
}
