// A statement the client can read.
//
// Everything the reservation knows, minus everything that is none of the
// client's business. That second half is the whole point of this module. The
// record holds the vendor's commission rate, what the agency earns and which
// lines earn it, passport numbers and expiry dates, the last four digits of a
// card, the advisor's private reminder dates and their own notes. None of that
// belongs in an email to a traveller.
//
// So this builds a deliberately narrow object, field by field, rather than
// passing the record through with the awkward parts deleted. A fact has to be
// named here to reach a client, which means a column added to the reservation
// next month cannot leak into a client's inbox by default.

import { json, badRequest, notFound, readJson } from './util.js';
import { requireUser } from './auth.js';
import { layout, escapeHtml, sendHtml } from './email.js';
import { listPricing } from './pricing.js';
import { listTravellers, listAmenities } from './travellers.js';
import * as db from './db.js';

// What a price line is called when a client reads it. "Non-commissionable
// fare" is a fact about the agency's pay, not about the client's holiday, and
// putting it in front of them invites a question with no good answer.
const CLIENT_LABEL = {
  fare: 'Fare', air: 'Air', insurance: 'Travel insurance',
  gratuities: 'Gratuities', transfers: 'Transfers', extra: 'Extras',
  ncf: 'Cruise line fees', taxes: 'Taxes and port fees', discount: 'Discount',
};

const KIND_LABEL = {
  deposit: 'Deposit', installment: 'Payment', final: 'Final balance', refund: 'Refund',
};

const sum = (rows) => rows.reduce((n, r) => n + (r.amountCents || 0), 0);

/**
 * Assembles what the client is told. Pure, so the boundary can be tested
 * without a database or an inbox.
 */
export function buildStatement({ booking, pricing, travellers, payments, amenities, client, user }) {
  const lines = (pricing || []).map((l) => ({
    label: l.label || CLIENT_LABEL[l.kind] || l.kind,
    amountCents: l.amount_cents || 0,
    deduct: l.kind === 'discount',
  }));

  // A discount is stored as a positive number and subtracted, the same way it
  // is on the advisor's own screen, so the two totals cannot drift apart.
  const brokenDown = lines.reduce((n, l) => n + (l.deduct ? -l.amountCents : l.amountCents), 0);
  const tripCents = lines.length ? brokenDown : (booking.gross_cents || 0);

  // Hard rows only. A soft row is the advisor's private reminder to chase the
  // same money a week early; showing a client two dates for one payment reads
  // as two payments, and showing them a date the vendor never set is worse.
  const hard = (payments || []).filter((p) => p.payment_class === 'hard');
  const posted = hard.filter((p) => p.paid_date).map((p) => ({
    label: KIND_LABEL[p.kind] || p.kind, date: p.paid_date, amountCents: p.amount_cents || 0,
  }));
  const due = hard.filter((p) => !p.paid_date && p.due_date).map((p) => ({
    label: KIND_LABEL[p.kind] || p.kind, date: p.due_date, amountCents: p.amount_cents || 0,
  }));

  const paidCents = sum(posted);

  // A quote and a booked trip are not the same document, and sending one as
  // the other is worse than sending nothing. A client who has not booked has
  // paid nothing and owes nothing; showing them "Received: $0.00" and a
  // balance for a trip they have not agreed to reads as a demand, and the
  // reply is not the one you wanted.
  const mode = booking.status === 'booked' || booking.status === 'travelled'
    ? 'statement' : 'quote';

  return {
    mode,
    clientName: (client && client.name) || booking.client_name || '',
    to: (client && client.email) || '',
    tripName: booking.product_name || '',
    vendor: booking.supplier || '',
    confirmation: booking.confirmation_number || '',
    departDate: booking.depart_date || '',
    returnDate: booking.return_date || '',
    itinerary: booking.itinerary || '',
    destination: booking.destination || '',
    cabin: [booking.cabin_category, booking.cabin].filter(Boolean).join(' · '),
    // Names only. A passport number in an email is a passport number in an
    // inbox, and neither of us can get it back out.
    travellers: (travellers || []).map((t) => t.name).filter(Boolean),
    lines,
    tripCents,
    // A quote carries no payment history because there is none. Empty arrays
    // rather than the fields being absent, so the page reading this does not
    // have to know which kind it asked for.
    posted: mode === 'quote' ? [] : posted,
    due: mode === 'quote' ? [] : due,
    paidCents: mode === 'quote' ? 0 : paidCents,
    // What it takes to hold it, which is the only number a quote should end
    // on. Null when the reservation does not say, rather than a guess.
    depositCents: mode === 'quote' ? (booking.deposit_cents || 0) || null : null,
    depositDue: mode === 'quote' ? (booking.deposit_due || '') : '',
    // What the client still owes on the whole trip, which is not the same as
    // what happens to be scheduled: a trip with a deposit paid and nothing
    // else booked in still has a balance, and it is the balance that matters.
    balanceCents: mode === 'quote' ? 0 : Math.max(0, tripCents - paidCents),
    scheduledCents: mode === 'quote' ? 0 : sum(due),
    // What the vendor granted them, without saying who paid for it.
    amenities: (amenities || [])
      .filter((a) => a.status === 'confirmed' || a.status === 'applied')
      .map((a) => ({ description: a.description, amountCents: a.amount_cents || 0 })),
    advisorName: [user.first_name, user.last_name].filter(Boolean).join(' ') || user.email,
    advisorEmail: user.email,
    agencyName: user.agency_name || '',
  };
}

const money = (cents) => `$${((cents || 0) / 100).toLocaleString('en-US', {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
})}`;

const day = (iso) => (iso
  ? new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US',
      { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
  : '');

function rows(items, { strike = false } = {}) {
  return items.map((i) => `<tr>
    <td style="padding:6px 0;color:#2f4459;">${escapeHtml(i.label)}${
      i.date ? `<span style="color:#5c7286;"> &middot; ${escapeHtml(day(i.date))}</span>` : ''}</td>
    <td style="padding:6px 0;text-align:right;color:#2f4459;white-space:nowrap;">${
      strike && i.deduct ? '&minus;' : ''}${money(i.amountCents)}</td>
  </tr>`).join('');
}

export function renderStatement(env, s) {
  const heading = [s.tripName, s.vendor].filter(Boolean).join(' with ')
    || (s.mode === 'quote' ? 'Your quote' : 'Your trip');

  const facts = [
    ['Confirmation', s.confirmation],
    ['Departing', day(s.departDate)],
    ['Returning', day(s.returnDate)],
    ['Itinerary', s.itinerary],
    ['Cabin', s.cabin],
    ['Travelling', s.travellers.join(', ')],
  ].filter(([, v]) => v);

  const block = (title, inner) => (inner
    ? `<p style="margin:22px 0 6px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#5c7286;">
         ${escapeHtml(title)}</p>
       <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
              style="font-size:15px;border-collapse:collapse;">${inner}</table>`
    : '');

  const totalRow = (label, cents, strong) => `<tr>
    <td style="padding:8px 0;border-top:1px solid #e4edf5;${strong ? 'font-weight:600;' : ''}color:#1b3a5f;">
      ${escapeHtml(label)}</td>
    <td style="padding:8px 0;border-top:1px solid #e4edf5;text-align:right;white-space:nowrap;${
      strong ? 'font-weight:600;' : ''}color:#1b3a5f;">${money(cents)}</td></tr>`;

  const quote = s.mode === 'quote';

  // What a quote ends on: the one thing the client has to do next, and by
  // when. A quote that stops at a total leaves them to work out what happens
  // now, and the commonest answer to that is nothing.
  const hold = quote
    ? `<p style="margin:22px 0 0;">${s.depositCents
        ? `A deposit of <strong>${money(s.depositCents)}</strong> holds this${
            s.depositDue ? ` and is due by ${escapeHtml(day(s.depositDue))}` : ''}.`
        : 'Say the word and I will hold it.'
      } Prices and space are not held until it is booked.</p>`
    : '';

  const body = [
    `<p style="margin:0 0 14px;">Hello ${escapeHtml(s.clientName || 'there')},</p>`,
    quote
      ? '<p style="margin:0 0 14px;">Here is what I have put together. Anything you would '
        + 'change, reply to this and I will rework it.</p>'
      : '<p style="margin:0 0 14px;">Here is where your trip stands. Anything that looks wrong, '
        + 'reply to this and I will sort it out.</p>',
    block(quote ? 'The trip' : 'Your trip', facts.map(([k, v]) => `<tr>
      <td style="padding:6px 0;color:#5c7286;width:38%;">${escapeHtml(k)}</td>
      <td style="padding:6px 0;color:#2f4459;">${escapeHtml(v)}</td></tr>`).join('')),
    block('What it costs', s.lines.length
      ? rows(s.lines, { strike: true }) + totalRow('Trip total', s.tripCents, true)
      : totalRow('Trip total', s.tripCents, true)),
    quote ? '' : block('Received, thank you', rows(s.posted)),
    quote ? '' : block('Still to come', s.due.length
      ? rows(s.due) + totalRow('Balance', s.balanceCents, true)
      : totalRow('Balance', s.balanceCents, true)),
    quote ? hold : '',
    s.amenities.length
      // Confirmed by the vendor only, in both documents. Listing something
      // that was merely asked for is a promise on somebody else's behalf, and
      // on a quote it is the promise that wins the sale and loses the client.
      ? block(quote ? 'Included in this price' : 'Included with your booking',
          s.amenities.map((a) => `<tr>
          <td style="padding:6px 0;color:#2f4459;">${escapeHtml(a.description)}</td>
          <td style="padding:6px 0;text-align:right;color:#5c7286;white-space:nowrap;">${
            a.amountCents ? money(a.amountCents) : ''}</td></tr>`).join(''))
      : '',
    `<p style="margin:24px 0 0;">${escapeHtml(s.advisorName)}${
      s.agencyName ? `<br><span style="color:#5c7286;">${escapeHtml(s.agencyName)}</span>` : ''}</p>`,
  ].filter(Boolean).join('');

  // The client's footer is their advisor, not the software. They have no
  // account in the portal and no reason to be shown its front door.
  const footer = [
    escapeHtml(s.advisorName),
    s.agencyName ? escapeHtml(s.agencyName) : '',
    `<a href="mailto:${escapeHtml(s.advisorEmail)}" style="color:#1b3a5f;">${
      escapeHtml(s.advisorEmail)}</a>`,
  ].filter(Boolean).join(' &middot; ');

  return {
    subject: s.mode === 'quote' ? `Your quote: ${heading}` : `Your trip: ${heading}`,
    html: layout(env, { heading, body, footer }),
  };
}

/**
 * Preview first, send second, as two separate requests.
 *
 * The same rule the payment chaser follows, for the same reason: an email to a
 * client cannot be recalled, and the preview returns exactly what would be
 * sent, from the same code that sends it.
 */
export async function handleStatement(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  // Self scope. An owner may read an associate's reservation, but sending a
  // client an email over that advisor's name is not reading.
  const booking = await db.getBooking(env, id, user.id);
  if (!booking) return notFound('Reservation not found.');

  // Nothing goes out about a trip that is off. Whatever the advisor meant to
  // send, this is not it.
  if (booking.status === 'cancelled') {
    return badRequest('That reservation is cancelled. Nothing should go to the client about it.');
  }

  const scope = db.selfScope(user);
  const [pricing, travellers, amenities, payments] = await Promise.all([
    listPricing(env, id, scope),
    listTravellers(env, id, scope),
    listAmenities(env, id, scope),
    db.listPayments(env, scope, { bookingId: id }),
  ]);

  const client = booking.client_id
    ? await db.getClient(env, scope, { id: booking.client_id })
    : await db.getClient(env, scope, { name: booking.client_name });

  const statement = buildStatement({
    booking, pricing, travellers, amenities, payments, client, user,
  });
  const { subject, html } = renderStatement(env, statement);

  const body = await readJson(request);
  if (body.preview) {
    return json({
      preview: true,
      to: statement.to || null,
      // Named rather than left to fail on send: the fix is on the client
      // record, and saying so is more use than an error.
      problem: statement.to ? null : 'That client has no email address on file.',
      // So the page can offer the fix rather than only the complaint.
      clientId: client ? client.id : null,
      subject,
      statement,
      html,
    });
  }

  if (!statement.to) return badRequest('That client has no email address on file.');

  try {
    await sendHtml(env, { to: statement.to, replyTo: user.email, subject, html });
  } catch (e) {
    return badRequest(String((e && e.message) || e).slice(0, 300));
  }

  await db.logActivity(env, user.id, 'booking.statement',
    `Sent ${statement.clientName} a statement`, { bookingId: id });
  return json({ ok: true, sentTo: statement.to, subject });
}
