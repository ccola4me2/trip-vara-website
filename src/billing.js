// Invoices and payments.
//
// This is the half that closes the loop on bookings. Bookings record what an
// advisor expects to earn; this records what was actually invoiced and
// actually collected. Both are shown together so the gap is visible instead of
// being taken on trust.

import { json, badRequest, clean, cleanDate, oneOf, readJson } from './util.js';
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
    db.bookingStats(env, db.scopeFor(env, user, request)),
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


/** Raise an invoice against a contact. */
export async function handleCreateInvoice(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const contactId = clean(body.contactId, 64);
  const name = clean(body.name, 160);
  const items = Array.isArray(body.items) ? body.items : [];

  if (!contactId) return badRequest('Pick a contact to invoice.');
  if (!name) return badRequest('Give the invoice a name.');

  const cleanItems = items
    .map((i) => ({
      name: clean(i.name, 160),
      amount: Number(String(i.amount ?? '').replace(/[$,\s]/g, '')) || 0,
      qty: Math.max(1, Math.min(Number(i.qty) || 1, 999)),
    }))
    .filter((i) => i.name && i.amount > 0);

  if (!cleanItems.length) return badRequest('Add at least one line item with an amount.');

  const issueDate = cleanDate(body.issueDate);
  const dueDate = cleanDate(body.dueDate);
  if (issueDate && dueDate && dueDate < issueDate) {
    return badRequest('The due date cannot be before the issue date.');
  }

  const locationId = ghl.locationFor(env, user);
  try {
    const contact = await db.localContact(env, contactId);
    const invoice = await ghl.createInvoice(env, locationId, {
      name,
      title: clean(body.title, 160) || name,
      contactId,
      contactName: contact?.name || clean(body.contactName, 120),
      contactEmail: contact?.email || '',
      contactPhone: contact?.phone || '',
      items: cleanItems,
      notes: clean(body.notes, 2000),
      issueDate: issueDate || undefined,
      dueDate: dueDate || undefined,
    });

    // Sending is opt-in: raising a draft and sending it are different
    // decisions, and sending by accident is not recoverable.
    let sent = false;
    if (body.send && invoice && invoice.id) {
      await ghl.sendInvoice(env, locationId, invoice.id, {
        action: oneOf(body.sendVia, ['email', 'sms', 'sms_and_email']),
        userId: user.ghl_user_id || undefined,
      });
      sent = true;
    }

    await db.logActivity(env, user.id, 'invoice.create',
      `${sent ? 'Sent' : 'Raised'} invoice ${name}`, { contactId, invoiceId: invoice?.id });
    return json({ ok: true, invoice, sent }, 201);
  } catch (e) {
    return ghl.ghlErrorResponse(e);
  }
}

/** Send an invoice that already exists. */
export async function handleSendInvoice(request, env, invoiceId) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const body = await readJson(request);
  try {
    await ghl.sendInvoice(env, ghl.locationFor(env, user), invoiceId, {
      action: oneOf(body.sendVia, ['email', 'sms', 'sms_and_email']),
      userId: user.ghl_user_id || undefined,
    });
    await db.logActivity(env, user.id, 'invoice.send', 'Sent an invoice', { invoiceId });
    return json({ ok: true });
  } catch (e) {
    return ghl.ghlErrorResponse(e);
  }
}
