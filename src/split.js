// How a commission is divided between the advisor who booked it and the agency.
//
// `advisor_split_pct` is the percentage the booking advisor keeps. The agency
// keeps the rest. A reservation with no split recorded falls back to the
// advisor's standing agreement, and an advisor with no standing agreement
// keeps all of it.
//
// NULL is not zero, and this is the whole reason the module exists. No split
// agreed means the advisor keeps what they earned; a deliberate 0 means the
// agency keeps everything, which is a real arrangement for a house account.
// `pct || 100` collapses one into the other and silently pays somebody.

/** The percentage the advisor keeps, given a reservation's value and their standing one. */
export function splitPct(bookingPct, advisorDefaultPct) {
  for (const v of [bookingPct, advisorDefaultPct]) {
    if (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v))) {
      return Math.max(0, Math.min(Number(v), 100));
    }
  }
  return 100;
}

/**
 * Splits a commission in two.
 *
 * The agency's share is the remainder rather than its own rounded figure, so
 * the two halves always add back up to the commission. Two independent
 * roundings are how a report ends up a cent short of itself.
 */
export function shareOf(commissionCents, pct) {
  const cents = commissionCents || 0;
  const kept = Math.max(0, Math.min(Number(pct), 100));
  const advisorCents = Math.round(cents * kept / 100);
  return { advisorCents, agencyCents: cents - advisorCents };
}

// The same arithmetic in SQLite, for the grouped reports that cannot pull
// rows into JavaScript. Kept next to shareOf so the two are read together, and
// checked against each other by the smoke test on a worked example.
//
// The split is resolved at read time rather than stamped onto a reservation
// when it is created. Changing an advisor's standing agreement then applies to
// every trip that has not been given its own figure, which is what changing an
// agreement means; a stamped copy would need a backfill and would silently
// disagree with the agreement it came from.
export const SPLIT_PCT_SQL = (bookingPct, advisorPct) =>
  `COALESCE(${bookingPct}, ${advisorPct}, 100)`;

export const ADVISOR_SHARE_SQL = (commission, pctExpr) =>
  `CAST(ROUND((${commission}) * (${pctExpr}) / 100.0) AS INTEGER)`;
