// Everything an agency has put in, in one file they can keep.
//
// This portal holds the only copy of a lot of what it knows. A reservation
// typed in here exists nowhere else: the vendor has their own record of their
// own booking, and nobody has the book. An agency that cannot get its own
// records out is an agency that cannot leave, and a product that cannot be
// left is one nobody should be asked to trust with their business.
//
// So: one request, one JSON file, every row the reader is allowed to see.
// Scoped exactly like the screens are, which means an owner exports the agency
// and an advisor exports themselves. Nothing here widens anything.
//
// Deliberately JSON and not a zip of CSVs. The point is to be able to put it
// back, and a reservation is a row plus its pricing lines, its payments, its
// travellers and its documents. Flattened into separate CSVs those joins are
// gone, and what comes out is a spreadsheet rather than a backup.
//
// Document bytes are not in it. The index is: filename, size, category and the
// R2 key, so a restore knows what is missing and can go and fetch it. Putting
// megabytes of PDFs inside a JSON file makes the one thing somebody reaches
// for in a hurry too big to open.

import { json, now } from './util.js';
import { requireUser, requirePlatformOwner } from './auth.js';
import * as db from './db.js';

/**
 * What goes in a bundle, in the order a restore would want it.
 *
 * Parents before children, so somebody replaying this into an empty database
 * can insert straight down the list without a foreign key complaining. D1 does
 * not enforce them, which makes the ordering a courtesy rather than a
 * requirement, and the courtesy costs nothing.
 *
 * Every table here is owned by user_id. That is the whole fence: there is no
 * table in this list that an advisor could reach a row of that is not theirs,
 * and no second predicate doing quiet work further down.
 */
export const EXPORT_TABLES = [
  'clients',
  'households',
  'vendors',
  'travel_groups',
  'group_rates',
  'group_registrations',
  'trips',
  'bookings',
  'booking_pricing',
  'booking_payments',
  'travellers',
  'amenities',
  'quote_options',
  'penalty_tiers',
  'client_credits',
  'itinerary_items',
  'documents',
  'tasks',
];

// Columns that are not the agency's business to carry around in a file. The
// hashes are useless outside this database and the object key is the only
// thing in `documents` that points at bytes, which is kept.
const DROP = new Set(['ip_hash', 'statement_hash']);

function tidy(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (!DROP.has(k)) out[k] = v;
  }
  return out;
}

/**
 * One table, fenced.
 *
 * Two statements rather than one built from `scopeWhere`, because the table
 * name is interpolated and check-scope then reads nothing but the statement's
 * own text. Both name user_id longhand for that reason, and both are pinned in
 * the checker with this file as the reason.
 */
async function readTable(env, table, scope) {
  const q = scope.all && scope.agencyId
    ? env.DB.prepare(
      `SELECT * FROM ${table} WHERE user_id IN (SELECT id FROM users WHERE agency_id = ?)`
    ).bind(scope.agencyId)
    : env.DB.prepare(
      `SELECT * FROM ${table} WHERE user_id = ?`
    ).bind(scope.userId);

  // A table missing from this database is a migration that has not been
  // applied, and an export that stops dead on it is worse than one that says
  // so and carries on with the other seventeen.
  try {
    const res = await q.all();
    return (res.results || []).map(tidy);
  } catch (e) {
    console.error('export', table, e);
    return null;
  }
}

/**
 * The agency's own record, minus the parts that are the portal operator's.
 *
 * The trial dates, the lock, the address a demo was signed up from: those are
 * how this platform runs its own business, not facts about the agency, and an
 * agency restoring itself somewhere else has no use for any of them.
 */
async function readAgency(env, agencyId) {
  if (!agencyId) return null;
  try {
    const row = await env.DB.prepare(
      `SELECT id, name, slug, address, phone, email, website, seller_of_travel,
              logo_url, brand_color, tagline, payment_form_url, created_at
         FROM agencies WHERE id = ?`
    ).bind(agencyId).first();
    return row || null;
  } catch {
    return null;
  }
}

/**
 * The advisors the bundle's rows point at, so a user_id in it means something.
 *
 * Names and email addresses only. Password hashes are not somebody's data to
 * carry off, splits are the agency's commercial terms with a person rather
 * than a record of travel, and neither is any use in a restore.
 */
async function readPeople(env, scope) {
  try {
    const res = scope.all && scope.agencyId
      ? await env.DB.prepare(
        `SELECT id, email, first_name, last_name, role, status
           FROM users WHERE agency_id = ?`
      ).bind(scope.agencyId).all()
      : await env.DB.prepare(
        `SELECT id, email, first_name, last_name, role, status
           FROM users WHERE id = ?`
      ).bind(scope.userId).all();
    return res.results || [];
  } catch {
    return [];
  }
}

/**
 * Build the bundle.
 *
 * `failed` names any table that could not be read rather than leaving it out
 * silently, which is the dashboard's rule and matters more here: a backup with
 * a table quietly missing is worse than no backup, because it is trusted.
 */
export async function buildBundle(env, user, scope) {
  const tables = {};
  const failed = [];

  for (const table of EXPORT_TABLES) {
    const rows = await readTable(env, table, scope);
    if (rows === null) failed.push(table);
    else tables[table] = rows;
  }

  const counts = {};
  for (const [name, rows] of Object.entries(tables)) counts[name] = rows.length;

  return {
    format: 'trip-vara-export',
    version: 1,
    takenAt: now(),
    takenBy: { id: user.id, email: user.email },
    covers: scope.all ? 'the whole agency' : 'one advisor',
    agency: await readAgency(env, scope.agencyId || user.agency_id),
    people: await readPeople(env, scope),
    counts,
    failed,
    tables,
  };
}

function fileName(bundle) {
  const day = new Date(bundle.takenAt * 1000).toISOString().slice(0, 10);
  const who = (bundle.agency && bundle.agency.slug) || 'trip-vara';
  return `${who}-${day}.json`;
}

export async function handleExport(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  // The reader's ordinary scope, with no ?advisor= honoured: an export is not
  // a screen somebody narrows, and an owner exporting one advisor would be a
  // second, quieter way to ask for records that the audit line would not
  // describe correctly.
  const scope = db.visibilityScope(env, user);
  const bundle = await buildBundle(env, user, scope);

  const total = Object.values(bundle.counts).reduce((a, b) => a + b, 0);
  await db.logActivity(env, user.id, 'data.export',
    `Exported ${total} records`, { covers: bundle.covers, failed: bundle.failed });

  return new Response(JSON.stringify(bundle, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${fileName(bundle)}"`,
      // Nothing between here and the browser should hold a copy of somebody's
      // whole book of business.
      'Cache-Control': 'no-store',
    },
  });
}

/** What the Settings card shows before anybody presses anything. */
export async function handleExportSummary(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const scope = db.visibilityScope(env, user);
  const counts = {};
  for (const table of EXPORT_TABLES) {
    const rows = await readTable(env, table, scope);
    counts[table] = rows === null ? null : rows.length;
  }
  return json({
    covers: scope.all ? 'the whole agency' : 'just you',
    counts,
    tables: EXPORT_TABLES,
  });
}

// ---------------------------------------------------------------- backups --

// How many weekly bundles to keep per agency. Eight weeks is long enough that
// a mistake nobody noticed for a month is still recoverable, and short enough
// that the bucket does not grow without end.
const KEEP_BACKUPS = 8;

const BACKUP_PREFIX = 'backups/';

/**
 * A copy of every agency's book, written where the agency cannot delete it.
 *
 * D1 has Time Travel, which answers "undo the last 30 days" and is the right
 * tool for a bad migration. It does not answer "the agency has gone and wants
 * its records", and it is not something an owner can reach. This is the second
 * kind of backup: a file per agency per week, in the private bucket, which
 * also happens to be the thing to hand somebody on their way out.
 *
 * Runs as the agency's own owner so the scope is the ordinary one. An agency
 * with no owner is skipped rather than exported with somebody else's fence,
 * and that gap is named in the result rather than swallowed.
 */
export async function backupAgencies(env, { today = new Date() } = {}) {
  if (!env.DOCS) return { skipped: 'no bucket' };

  const day = today.toISOString().slice(0, 10);
  const agencies = await env.DB.prepare(
    "SELECT id, slug FROM agencies WHERE plan IS NULL OR plan <> 'demo'"
  ).all();

  const done = [];
  const skipped = [];

  for (const agency of agencies.results || []) {
    const owner = await env.DB.prepare(
      "SELECT id, email, agency_id FROM users WHERE agency_id = ? AND role = 'admin' AND status = 'active' LIMIT 1"
    ).bind(agency.id).first();
    if (!owner) { skipped.push(agency.slug || agency.id); continue; }

    const key = `${BACKUP_PREFIX}${agency.id}/${day}.json`;
    // Idempotent on purpose. The cron ticks every five minutes and the window
    // this runs in is an hour wide, so without this one Sunday would write the
    // same bundle twelve times. Checking is one HEAD against a bucket; the
    // alternative is a schedule that has to be exactly right forever.
    if (await env.DOCS.head(key)) { skipped.push(agency.slug || agency.id); continue; }

    const scope = { all: true, agencyId: agency.id, userId: owner.id, self: false };
    const bundle = await buildBundle(env, owner, scope);
    await env.DOCS.put(key, JSON.stringify(bundle), {
      httpMetadata: { contentType: 'application/json' },
    });
    await prune(env, agency.id);
    done.push(agency.slug || agency.id);
  }

  return { day, done, skipped };
}

/** Keep the newest KEEP_BACKUPS for one agency and remove the rest. */
async function prune(env, agencyId) {
  const listed = await env.DOCS.list({ prefix: `${BACKUP_PREFIX}${agencyId}/` });
  const keys = (listed.objects || []).map((o) => o.key).sort();
  const old = keys.slice(0, Math.max(0, keys.length - KEEP_BACKUPS));
  for (const key of old) await env.DOCS.delete(key);
}

/**
 * Run the backup by hand.
 *
 * Whoever runs the portal, not an agency owner: it writes every agency's
 * bundle, so it is the operator's button and lives beside the other ones on
 * the admin page.
 */
export async function handleRunBackup(request, env) {
  const { user, response } = await requirePlatformOwner(request, env);
  if (response) return response;

  const result = await backupAgencies(env);
  await db.logActivity(env, user.id, 'data.backup',
    `Backed up ${(result.done || []).length} agencies`, { day: result.day });
  return json(result);
}
