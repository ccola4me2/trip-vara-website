// Invoices and payments.
//
// This is the half that closes the loop on bookings. Bookings record what an
// advisor expects to earn; this records what was actually invoiced and
// actually collected. Both are shown together so the gap is visible instead of
// being taken on trust.

import { json } from './util.js';
import { requireUser } from './auth.js';
import * as ghl from './ghl.js';
import * as db from './db.js';

const PAID = new Set(['paid', 'succeeded', 'success', 'completed']);
const OUTSTANDING = new Set(['sent', 'overdue', 'partially_paid', 'payment_processing']);

export async function handleBilling(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const url = new URL(request.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 100);
  const locationId = ghl.locationFor(env, user);

  // Each source is independent, so one failing does not blank the page.
  const [invoiceRes, txRes, subs, bookingStats] = await Promise.all([
    ghl.listInvoices(env, locationId, { limit }).catch((e) => ({ error: e })),
    ghl.listTransactions(env, locationId, { limit }).catch((e) => ({ error: e })),
    ghl.listSubscriptions(env, locationId, { limit }).catch(() => null),
    db.bookingStats(env, user.id),
  ]);

  // If both CRM sources failed, that is a real failure worth surfacing.
  if (invoiceRes.error && txRes.error) return ghl.ghlErrorResponse(invoiceRes.error);

  const invoices = invoiceRes.error ? [] : invoiceRes.invoices;
  const transactions = txRes.error ? [] : txRes.transactions;

  const invoicedCents = invoices.reduce((n, i) => n + i.totalCents, 0);
  const collectedCents = invoices.reduce((n, i) => n + i.paidCents, 0);
  const outstandingCents = invoices
    .filter((i) => OUTSTANDING.has(i.status))
    .reduce((n, i) => n + (i.dueCents || i.totalCents - i.paidCents), 0);
  const settledCents = transactions
    .filter((t) => PAID.has(t.status))
    .reduce((n, t) => n + t.amountCents, 0);

  return json({
    invoices,
    transactions,
    subscriptions: subs || [],
    stats: {
      invoicedCents,
      collectedCents,
      outstandingCents,
      settledCents,
      invoiceCount: invoices.length,
      transactionCount: transactions.length,
    },
    // The bookings side, so the page can show expected against actual.
    bookings: {
      grossCents: bookingStats.grossCents,
      commissionCents: bookingStats.commissionCents,
      commissionPaidCents: bookingStats.commissionPaidCents,
    },
    unavailable: {
      invoices: Boolean(invoiceRes.error),
      transactions: Boolean(txRes.error),
      subscriptions: subs === null,
    },
  });
}
