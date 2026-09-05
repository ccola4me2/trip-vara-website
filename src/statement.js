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

  return {
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
    posted,
    due,
    paidCents,
    // What the client still owes on the whole trip, which is not the same as
    // what happens to be scheduled: a trip with a deposit paid and nothing
    // else booked in still has a balance, and it is the balance that matters.
    balanceCents: Math.max(0, tripCents - paidCents),
    scheduledCents: sum(due),
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
  const heading = [s.tripName, s.vendor].filter(Boolean).join(' with ') || 'Your trip';

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

  const body = [
    `<p style="margin:0 0 14px;">Hello ${escapeHtml(s.clientName || 'there')},</p>`,
    '<p style="margin:0 0 14px;">Here is where your trip stands. Anything that looks wrong, '
      + 'reply to this and I will sort it out.</p>',
    block('Your trip', facts.map(([k, v]) => `<tr>
      <td style="padding:6px 0;color:#5c7286;width:38%;">${escapeHtml(k)}</td>
      <td style="padding:6px 0;color:#2f4459;">${escapeHtml(v)}</td></tr>`).join('')),
    block('What it costs', s.lines.length
      ? rows(s.lines, { strike: true }) + totalRow('Trip total', s.tripCents, true)
      : totalRow('Trip total', s.tripCents, true)),
    block('Received, thank you', rows(s.posted)),
    block('Still to come', s.due.length
      ? rows(s.due) + totalRow('Balance', s.balanceCents, true)
      : totalRow('Balance', s.balanceCents, true)),
    s.amenities.length
      ? block('Included with your booking', s.amenities.map((a) => `<tr>
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

  return { subject: `Your trip: ${heading}`, html: layout(env, { heading, body, footer }) };
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
