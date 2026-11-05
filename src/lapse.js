// When a paying agency stops being able to use the portal.
//
// Its own file because both the door every request comes through (auth.js) and
// the billing handlers need the answer, and billing.js already imports auth.js.
//
// A failed payment is not a lock. Cards expire and banks decline a charge that
// is fine on the second try, so a paying agency gets seven days from the first
// failure before anything stops. A cancelled subscription has no grace: the
// person pressed the button, and Stripe only reports it once the period they
// paid for has run out.
//
// Locked is not deleted. Nothing in this file or its callers removes a row, and
// paying again switches everything back on exactly as it was.

export const GRACE_DAYS = 7;

const DAY = 86400;

/** Whether this agency is locked for want of payment, and when the grace ends. */
export function lapseState(agency, at = Math.floor(Date.now() / 1000)) {
  if (!agency || agency.plan !== 'live') return { locked: false, graceEndsAt: null };
  if (agency.billing_status === 'canceled') return { locked: true, graceEndsAt: null };
  if (agency.billing_status === 'past_due' && agency.past_due_since) {
    const graceEndsAt = agency.past_due_since + GRACE_DAYS * DAY;
    return { locked: graceEndsAt <= at, graceEndsAt };
  }
  return { locked: false, graceEndsAt: null };
}

/** What a locked advisor is told. No number: the owner's own dates are on the billing page. */
export const LAPSED_MESSAGE = 'This agency’s subscription has lapsed. Everything you entered is still here. '
  + 'Ask your agency owner to update billing and the account switches straight back on.';
