// Reading a vendor confirmation instead of retyping it.
//
// Booking a cruise produces a confirmation email with every fact the portal
// wants: the number, the ship, the dates, the cabin, the guests, the money.
// The advisor then types all of it in again from the other window. That
// retyping is the friction that decides whether a CRM gets used at all, and
// it is the one thing every advisor does after every booking.
//
// Deliberately a reader, not an importer. It fills a form and stops. Vendor
// confirmations have no standard shape, so this will misread some of them,
// and a parser that writes a reservation straight to the database on a guess
// is worse than typing: a wrong sail date somebody corrected is a nuisance, a
// wrong sail date nobody saw is a missed holiday.
//
// So every field comes back with the line it was read from, and the page
// shows both. The advisor is confirming what was read, not trusting it.

import { clean, toCents, json, badRequest, readJson } from './util.js';
import { requireUser } from './auth.js';
import { personName, splitVendor, anyDate } from './importer.js';

// Longest first: "grand total" must win before "total" sees the same line.
const LABELS = {
  confirmationNumber: ['confirmation number', 'reservation number', 'booking number',
    'booking reference', 'booking id', 'reservation id', 'confirmation code',
    'confirmation', 'conf #', 'conf no', 'res #', 'booking'],
  supplier: ['cruise line', 'travel supplier', 'supplier', 'vendor', 'carrier', 'operator'],
  productName: ['ship name', 'ship', 'vessel', 'resort', 'hotel', 'tour name', 'package'],
  departDate: ['embarkation date', 'embarkation', 'sailing date', 'sail date',
    'departure date', 'depart date', 'start date', 'check-in date', 'check in date',
    'departs', 'departure'],
  returnDate: ['disembarkation date', 'disembarkation', 'debarkation date', 'debarkation',
    'return date', 'end date', 'check-out date', 'check out date', 'returns'],
  destination: ['destination', 'itinerary', 'region', 'sailing'],
  cabin: ['stateroom number', 'cabin number', 'room number', 'stateroom', 'cabin', 'room'],
  cabinCategory: ['stateroom category', 'cabin category', 'room type', 'category', 'grade'],
  gross: ['grand total', 'total price', 'total cost', 'total amount', 'trip total',
    'total due', 'total'],
  deposit: ['deposit amount', 'initial payment', 'deposit paid', 'deposit'],
  finalPaymentDue: ['final payment due', 'final payment date', 'balance due date',
    'final payment', 'balance due'],
};

const MONEY = /-?\$?\s*[\d,]+(?:\.\d{2})?/;

/**
 * Finds "Label: value" at the start of a line.
 *
 * Anchored to the line start on purpose. A label found mid-sentence is
 * usually prose about the label rather than the value, and "your total is due
 * on the date shown below" is not a total.
 */
function pick(lines, aliases) {
  for (const alias of aliases) {
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      const lower = line.toLowerCase();
      if (!lower.startsWith(alias)) continue;

      const rest = line.slice(alias.length);
      // Something has to separate the label from the value, or "Categories of
      // cabin" reads as the category "of cabin".
      const m = rest.match(/^\s*[:\-–—]\s*(.+)$/) || rest.match(/^\s{2,}(.+)$/) || rest.match(/^\t+(.+)$/);
      if (!m) continue;
      const value = m[1].trim();
      if (value) return { value, line };
    }
  }
  return null;
}

/**
 * "COLE/DEBORAH" becomes "Deborah Cole".
 *
 * Cruise lines write names in capitals. A client record that keeps them ends
 * up greeting somebody as "Hello DEBORAH COLE" in every email they get.
 *
 * Only applied to input that is entirely upper case, so a name already cased
 * properly is never touched. It gets McDonald wrong, and O'Brien and
 * Smith-Jones right. That is a visible error in a form the advisor is about to
 * read, which is a better place for it than in a client's inbox.
 */
function fixCaps(name) {
  if (name !== name.toUpperCase()) return name;
  return name.toLowerCase().replace(/(^|[\s'\-])([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase());
}

/** Guest and passenger lines, in the order the confirmation lists them. */
function guests(lines) {
  const out = [];
  for (const raw of lines) {
    const line = raw.trim();
    const m = line.match(/^(?:guest|passenger|traveler|traveller)\s*#?\s*\d*\s*[:\-]\s*(.+)$/i);
    if (!m) continue;
    // "SMITH/JOHN" is how a cruise line writes a name and not how a person does.
    const name = fixCaps(personName(m[1].replace(/\//g, ', ').replace(/\s+/g, ' ').trim()));
    if (name && !out.some((g) => g.name.toLowerCase() === name.toLowerCase())) {
      out.push({ name, line });
    }
  }
  return out;
}

const money = (v) => {
  const m = String(v).match(MONEY);
  return m ? toCents(m[0].replace(/[$,\s]/g, '')) : 0;
};

/**
 * What could be read, and what it was read from.
 *
 * Returns fields and provenance side by side. Nothing is filled in that was
 * not on the page: a confirmation with no return date comes back with no
 * return date, rather than one worked out from a sailing length nobody stated.
 */
export function parseConfirmation(text) {
  const lines = String(text || '').split(/\r?\n/).slice(0, 400);
  const fields = {};
  const from = {};

  const take = (key, aliases, transform) => {
    const hit = pick(lines, aliases);
    if (!hit) return;
    const value = transform ? transform(hit.value) : clean(hit.value, 200);
    if (value === null || value === undefined || value === '' || value === 0) return;
    fields[key] = value;
    from[key] = hit.line.slice(0, 160);
  };

  take('confirmationNumber', LABELS.confirmationNumber, (v) => clean(v.split(/\s{2,}/)[0], 80));
  take('supplier', LABELS.supplier);
  take('productName', LABELS.productName);
  take('departDate', LABELS.departDate, anyDate);
  take('returnDate', LABELS.returnDate, anyDate);
  take('destination', LABELS.destination);
  take('cabin', LABELS.cabin, (v) => clean(v, 40));
  take('cabinCategory', LABELS.cabinCategory, (v) => clean(v, 120));
  take('finalPaymentDue', LABELS.finalPaymentDue, anyDate);
  take('gross', LABELS.gross, (v) => (money(v) ? (money(v) / 100).toFixed(2) : null));
  take('deposit', LABELS.deposit, (v) => (money(v) ? (money(v) / 100).toFixed(2) : null));

  // "Margaritaville at Sea (Islander)" on one line is a vendor and a ship.
  if (fields.supplier && !fields.productName) {
    const split = splitVendor(fields.supplier);
    if (split.productName) {
      fields.supplier = split.supplier;
      fields.productName = split.productName;
    }
  }

  const people = guests(lines);
  if (people.length) {
    fields.travellers = people.length;
    // The lead guest is the client unless the advisor says otherwise. Named
    // rather than assumed silently: the page shows where it came from.
    fields.clientName = people[0].name;
    from.clientName = people[0].line.slice(0, 160);
    from.travellers = `${people.length} guest line${people.length === 1 ? '' : 's'}`;
  }

  // A return before a departure is a misread, not a trip. Dropped rather than
  // saved, because the advisor is more likely to accept a filled field than
  // to notice a wrong one.
  if (fields.departDate && fields.returnDate && fields.returnDate < fields.departDate) {
    delete fields.returnDate;
    delete from.returnDate;
  }

  return {
    fields,
    from,
    guests: people.map((g) => g.name),
    // Named so the page can say what it did not find rather than leaving the
    // advisor to notice the blanks.
    missing: Object.keys(LABELS).filter((k) => fields[k] === undefined),
  };
}

export async function handleReadConfirmation(request, env) {
  const { response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const text = String(body.text || '');
  if (text.trim().length < 20) {
    return badRequest('Paste the confirmation email or the booking summary from the vendor.');
  }

  const read = parseConfirmation(text);
  if (!Object.keys(read.fields).length) {
    return badRequest('Nothing recognisable in that. It reads labelled lines like '
      + '"Confirmation Number: 12345", which is how most vendor confirmations are laid out.');
  }
  return json(read);
}
