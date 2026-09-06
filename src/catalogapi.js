import { knownCruiseLines } from './catalogmirror.js';
// The catalog, as the portal uses it.
//
// Read endpoints for the sailing picker, an admin view of the import, and the
// one that pays for the whole thing: filling in what a pasted book of business
// could not carry.

import { json, badRequest, notFound, clean, readJson } from './util.js';
import { requireUser, requireAdmin } from './auth.js';
import * as db from './db.js';
import {
  catalogLines, catalogShips, catalogDates, matchSailing,
  importCatalogStep, importStatus, catalogReady, catalogSearch, catalogFacets, withReturn,
} from './catalog.js';

export async function handleCatalogLines(request, env) {
  const { response } = await requireUser(request, env);
  if (response) return response;
  return json({ knownCruiseLines: await knownCruiseLines(env), lines: await catalogLines(env), ready: await catalogReady(env) });
}

export async function handleCatalogSearch(request, env) {
  const { response } = await requireUser(request, env);
  if (response) return response;

  const p = new URL(request.url).searchParams;
  const [result, facets] = await Promise.all([
    catalogSearch(env, {
      q: clean(p.get('q'), 80),
      line: clean(p.get('line'), 120),
      destination: clean(p.get('destination'), 80),
      port: clean(p.get('port'), 80),
      from: clean(p.get('from'), 10),
      to: clean(p.get('to'), 10),
      minNights: Number(p.get('minNights')) || 0,
      maxNights: Number(p.get('maxNights')) || 0,
      limit: Number(p.get('limit')) || 60,
      offset: Number(p.get('offset')) || 0,
    }),
    catalogFacets(env),
  ]);

  return json({ ...result, ...facets, lines: await catalogLines(env), ready: await catalogReady(env) });
}

/** One sailing, so a reservation can be started from it. */
export async function handleCatalogSailing(request, env) {
  const { response } = await requireUser(request, env);
  if (response) return response;

  const id = clean(new URL(request.url).searchParams.get('id'), 80);
  if (!id) return badRequest('Which sailing?');

  const row = await env.DB.prepare(
    `SELECT id, cruise_line, ship, name, depart_date, return_date, nights,
            departure_port, disembark_port, destination
       FROM sailings WHERE id = ?`
  ).bind(id).first();
  if (!row) return notFound('That sailing is not in the catalog.');
  return json({ sailing: withReturn(row) });
}

export async function handleCatalogShips(request, env) {
  const { response } = await requireUser(request, env);
  if (response) return response;
  const line = clean(new URL(request.url).searchParams.get('line'), 120);
  if (!line) return badRequest('Pick a cruise line first.');
  return json({ ships: await catalogShips(env, line) });
}

export async function handleCatalogDates(request, env) {
  const { response } = await requireUser(request, env);
  if (response) return response;
  const url = new URL(request.url);
  const ship = clean(url.searchParams.get('ship'), 120);
  if (!ship) return badRequest('Pick a ship first.');
  return json({ dates: await catalogDates(env, ship, clean(url.searchParams.get('line'), 120)) });
}

export async function handleCatalogStatus(request, env) {
  const { response } = await requireAdmin(request, env);
  if (response) return response;
  return json(await importStatus(env));
}

export async function handleCatalogImport(request, env) {
  const { response } = await requireAdmin(request, env);
  if (response) return response;
  const body = await readJson(request);
  return json(await importCatalogStep(env, {
    maxPages: Math.min(Math.max(Number(body.maxPages) || 6, 1), 40),
    force: body.force === true,
  }));
}

/**
 * What the catalog knows that a pasted reservation does not.
 *
 * A copied list carries a departure date and no return date, because no back
 * office puts one in a list. Ship and departure together identify a sailing, so
 * the return, the nights and the region can be recovered.
 *
 * Suggested, never applied on its own. The match is a strong guess rather than
 * a fact: two ships can share a name across lines, and a chartered or
 * repositioned sailing will not match at all. A date written in by software is
 * indistinguishable afterwards from one an advisor confirmed, and the whole
 * point of this portal is that its dates can be trusted.
 */
export async function handleCatalogSuggest(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  if (!(await catalogReady(env))) {
    return json({ ready: false, suggestions: [] });
  }

  const scope = db.selfScope(user);
  const scoped = db.scopeWhere(scope, 'b.user_id');
  const { results } = await env.DB.prepare(
    `SELECT b.id, b.client_name, b.supplier, b.product_name, b.depart_date,
            b.return_date, b.destination
       FROM bookings b
      WHERE ${scoped.sql} AND b.status IN ('quoted','booked','travelled')
        AND b.depart_date IS NOT NULL
        AND (b.return_date IS NULL OR b.destination IS NULL OR b.destination = '')
      ORDER BY b.depart_date DESC LIMIT 200`
  ).bind(...scoped.binds).all().catch(() => ({ results: [] }));

  const suggestions = [];
  for (const r of results || []) {
    // The ship is usually in product_name after an import; fall back to the
    // vendor field, since some lists put the ship there instead.
    const found = await matchSailing(env, r.product_name || r.supplier, r.depart_date);
    if (!found) continue;
    const fills = {};
    if (!r.return_date && found.return_date) fills.returnDate = found.return_date;
    if ((!r.destination || !r.destination.trim()) && found.destination) fills.destination = found.destination;
    if (!Object.keys(fills).length) continue;
    suggestions.push({
      id: r.id,
      clientName: r.client_name,
      departDate: r.depart_date,
      ship: found.ship,
      line: found.cruise_line,
      itinerary: found.name,
      nights: found.nights,
      fills,
    });
  }

  return json({ ready: true, suggestions });
}

/** Apply the suggestions the advisor picked, one reservation at a time. */
export async function handleCatalogApply(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const ids = Array.isArray(body.ids)
    ? body.ids.filter((x) => typeof x === 'string').slice(0, 200) : [];
  if (!ids.length) return badRequest('Nothing was selected.');

  let changed = 0;
  for (const id of ids) {
    const booking = await db.getBooking(env, id, user.id);
    if (!booking || !booking.depart_date) continue;
    const found = await matchSailing(env, booking.product_name || booking.supplier, booking.depart_date);
    if (!found) continue;

    const sets = [];
    const binds = [];
    // Only ever fills a gap. Overwriting a date an advisor typed with one from
    // a feed is how a tool loses the right to be trusted.
    if (!booking.return_date && found.return_date) { sets.push('return_date = ?'); binds.push(found.return_date); }
    if (!booking.destination && found.destination) { sets.push('destination = ?'); binds.push(found.destination); }
    if (!sets.length) continue;

    await env.DB.prepare(
      `UPDATE bookings SET ${sets.join(', ')}, updated_at = ? WHERE id = ? AND user_id = ?`
    ).bind(...binds, Math.floor(Date.now() / 1000), id, user.id).run();
    changed += 1;
  }

  await db.logActivity(env, user.id, 'catalog.apply',
    `Filled ${changed} reservation${changed === 1 ? '' : 's'} from the sailing catalog`, { changed });
  return json({ ok: true, requested: ids.length, changed });
}
