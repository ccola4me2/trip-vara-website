// Bringing an existing book of business across.
//
// A CRM with nothing in it is a demo. Most advisors arriving here have years
// of reservations somewhere else, and no back office worth the name offers a
// clean export, so the realistic path is to select the rows on screen and
// paste them. This accepts that paste.
//
// The parser runs on the server and the preview uses the same call as the
// import, so what you are shown is what will be created. Two parsers, one for
// preview and one for the write, is how a preview ends up lying.

import { json, badRequest, clean, cleanDate, toCents, oneOf, readJson } from './util.js';
import { requireUser } from './auth.js';
import * as db from './db.js';

const MAX_ROWS = 500;

// The fields a row can carry. Order matters only for the unheaded case, where
// it is the order the columns are assumed to be in.
export const FIELDS = [
  'clientName', 'supplier', 'productName', 'departDate', 'returnDate',
  'confirmationNumber', 'gross', 'commission', 'status', 'destination',
];

// What a column heading has to contain to be recognised. Checked in order, so
// the more specific patterns come first.
const HEADINGS = [
  [/^(client|passenger|guest|name|last.*first)/i, 'clientName'],
  [/^(vendor|supplier|cruise line|carrier)/i, 'supplier'],
  [/^(ship|product|resort|property|itinerary)/i, 'productName'],
  [/^(depart|sail|travel date|start)/i, 'departDate'],
  [/^(return|end|back)/i, 'returnDate'],
  [/^(conf|booking (no|num|ref)|reservation (no|num))/i, 'confirmationNumber'],
  [/^(gross|total|fare|price|amount|value)/i, 'gross'],
  [/^(comm)/i, 'commission'],
  [/^(status)/i, 'status'],
  [/^(destination|region|area)/i, 'destination'],
];

/** Splits a line on tabs, or on commas when there are no tabs. */
function splitLine(line) {
  if (line.includes('\t')) return line.split('\t').map((c) => c.trim());
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { cur += '"'; i++; } else quoted = !quoted;
    } else if (ch === ',' && !quoted) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/**
 * "Montoro, Manuel" becomes "Manuel Montoro".
 *
 * Back offices list people surname first for sorting. Storing it that way
 * means every screen, email and vendor confirmation reads backwards, so it is
 * turned around on the way in rather than lived with forever.
 */
function personName(raw) {
  const value = clean(raw, 120);
  if (!value) return '';
  const parts = value.split(',');
  if (parts.length === 2 && parts[0].trim() && parts[1].trim()) {
    return `${parts[1].trim()} ${parts[0].trim()}`.slice(0, 120);
  }
  return value;
}

/**
 * "Margaritaville at Sea (Islander)" becomes vendor and ship separately.
 *
 * Kept apart because the vendor is who you chase for commission and the ship
 * is what the client thinks they bought, and a report grouped by the pair is
 * a report grouped by nothing.
 */
function splitVendor(raw) {
  const value = clean(raw, 200);
  const match = value.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (!match) return { supplier: value.slice(0, 120), productName: '' };
  let ship = match[2].trim();
  const vendor = match[1].trim();
  // "Margaritaville at Sea (Margaritaville at Sea Islander)" says the vendor
  // twice. Keep the part that is actually the ship.
  if (ship.toLowerCase().startsWith(vendor.toLowerCase())) {
    ship = ship.slice(vendor.length).trim() || ship;
  }
  return { supplier: vendor.slice(0, 120), productName: ship.slice(0, 160) };
}

/** m/d/yy, m/d/yyyy, yyyy-mm-dd and d Mon yyyy, or nothing. */
function anyDate(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;

  const iso = cleanDate(value);
  if (iso) return iso;

  const slash = value.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/);
  if (slash) {
    const [, m, d, y] = slash;
    // A two digit year is this century. A travel agency's records do not run
    // back to the 1900s, and guessing 1927 for a 2027 sailing is worse than
    // refusing the row.
    const year = y.length === 2 ? 2000 + Number(y) : Number(y);
    const out = `${year}-${String(Number(m)).padStart(2, '0')}-${String(Number(d)).padStart(2, '0')}`;
    return cleanDate(out);
  }

  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString().slice(0, 10);
  return null;
}

/** Turns pasted text into rows, with the problems named rather than dropped. */
export function parsePaste(text, mapping) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim());
  if (!lines.length) return { columns: [], rows: [], skippedHeader: false };

  let columns = Array.isArray(mapping) && mapping.length ? mapping.slice(0, 20) : null;
  let start = 0;

  if (!columns) {
    const first = splitLine(lines[0]);
    const guessed = first.map((cell) => {
      const hit = HEADINGS.find(([re]) => re.test(cell.trim()));
      return hit ? hit[1] : '';
    });
    // Treated as a heading row only if most cells name something. A row of
    // real data occasionally matches one pattern by accident.
    if (guessed.filter(Boolean).length >= Math.max(2, Math.ceil(first.length / 2))) {
      columns = guessed;
      start = 1;
    } else {
      columns = FIELDS.slice(0, first.length);
    }
  }

  const rows = [];
  for (let i = start; i < lines.length && rows.length < MAX_ROWS; i++) {
    const cells = splitLine(lines[i]);
    const raw = {};
    columns.forEach((field, n) => { if (field) raw[field] = cells[n] ?? ''; });

    const vendorParts = splitVendor(raw.supplier || '');
    const row = {
      line: i + 1,
      clientName: personName(raw.clientName),
      supplier: vendorParts.supplier,
      productName: clean(raw.productName, 160) || vendorParts.productName,
      destination: clean(raw.destination, 160),
      confirmationNumber: clean(raw.confirmationNumber, 80),
      departDate: anyDate(raw.departDate),
      returnDate: anyDate(raw.returnDate),
      gross: raw.gross ? String(raw.gross).replace(/[^0-9.]/g, '') : '',
      commission: raw.commission ? String(raw.commission).replace(/[^0-9.]/g, '') : '',
      status: oneOf(raw.status, ['quoted', 'booked', 'travelled', 'cancelled']),
      problems: [],
    };

    if (!row.clientName) row.problems.push('no client name');
    if (raw.departDate && !row.departDate) row.problems.push(`could not read the date "${raw.departDate}"`);
    rows.push(row);
  }

  return { columns, rows, skippedHeader: start === 1 };
}

export async function handlePreviewImport(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const parsed = parsePaste(body.text, body.mapping);

  // Which of these are already here, so the preview can say "12 new, 8 you
  // already have" rather than importing duplicates and leaving you to find
  // them afterwards.
  const existing = new Set();
  const refs = parsed.rows.map((r) => r.confirmationNumber).filter(Boolean);
  if (refs.length) {
    const marks = refs.map(() => '?').join(',');
    const { results } = await env.DB.prepare(
      `SELECT confirmation_number FROM bookings
        WHERE user_id = ? AND confirmation_number IN (${marks})`
    ).bind(user.id, ...refs).all().catch(() => ({ results: [] }));
    for (const r of results || []) existing.add(r.confirmation_number);
  }

  const rows = parsed.rows.map((r) => ({
    ...r,
    duplicate: Boolean(r.confirmationNumber && existing.has(r.confirmationNumber)),
  }));

  return json({
    columns: parsed.columns,
    fields: FIELDS,
    skippedHeader: parsed.skippedHeader,
    rows,
    summary: {
      total: rows.length,
      ready: rows.filter((r) => !r.problems.length && !r.duplicate).length,
      duplicates: rows.filter((r) => r.duplicate).length,
      problems: rows.filter((r) => r.problems.length).length,
    },
  });
}

export async function handleRunImport(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const parsed = parsePaste(body.text, body.mapping);
  if (!parsed.rows.length) return badRequest('There was nothing to import.');

  const refs = parsed.rows.map((r) => r.confirmationNumber).filter(Boolean);
  const existing = new Set();
  if (refs.length) {
    const marks = refs.map(() => '?').join(',');
    const { results } = await env.DB.prepare(
      `SELECT confirmation_number FROM bookings
        WHERE user_id = ? AND confirmation_number IN (${marks})`
    ).bind(user.id, ...refs).all().catch(() => ({ results: [] }));
    for (const r of results || []) existing.add(r.confirmation_number);
  }

  let created = 0;
  let skipped = 0;
  const failures = [];

  for (const row of parsed.rows) {
    if (row.problems.length) { skipped += 1; continue; }
    if (row.confirmationNumber && existing.has(row.confirmationNumber)) { skipped += 1; continue; }

    try {
      const clientId = await db.resolveClient(env, user.id, row.clientName);
      await db.createBooking(env, user.id, {
        clientName: row.clientName,
        supplier: row.supplier,
        productType: 'cruise',
        productName: row.productName,
        destination: row.destination,
        confirmationNumber: row.confirmationNumber,
        departDate: row.departDate,
        returnDate: row.returnDate,
        depositDue: null,
        finalPaymentDue: null,
        travellers: 1,
        grossCents: toCents(row.gross),
        depositCents: 0,
        commissionCents: toCents(row.commission),
        commissionStatus: 'pending',
        status: row.status,
        notes: 'Imported',
        clientId,
      });
      created += 1;
      // Within one paste as well as against the database, so a list pasted
      // twice in the same box does not import twice.
      if (row.confirmationNumber) existing.add(row.confirmationNumber);
    } catch (e) {
      failures.push({ line: row.line, client: row.clientName, error: String(e && e.message || e).slice(0, 200) });
    }
  }

  await db.logActivity(env, user.id, 'import.reservations',
    `Imported ${created} reservation${created === 1 ? '' : 's'}`, { created, skipped });

  return json({ ok: true, created, skipped, failures });
}
