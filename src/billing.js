// Paying for Trip Vara.
//
// The portal never touches a card. An owner presses Subscribe, goes to Stripe's
// own checkout, and Stripe tells this Worker what happened by webhook. Everything
// here is either the two buttons that start that (checkout and the customer
// page), the webhook that hears the result, or the sweep that keeps what is
// billed in step with how many advisors there are.
//
// It does nothing until it is switched on. With no Stripe key set the buttons
// say billing is not on yet and the webhook refuses, so the code can ship and
// be read by somebody before it can charge anyone.
//
// The price is the pricing page's: $29 an advisor, and never more than $300.
// That is two tiers on one Stripe price. The first ten advisors are $29 each,
// and the next fifteen are a flat $10 for the lot, which is how eleven advisors
// come to $300 and twenty five come to $300. Past twenty five is a
// conversation, so checkout refuses it rather than quoting a number the page
// never promised.

import { json, badRequest, now, readJson } from './util.js';
import { requireUser, requireAdmin, isAdmin } from './auth.js';
import * as db from './db.js';
import { lapseState, GRACE_DAYS } from './lapse.js';
import { sendSubscribedEmail } from './email.js';

export const MAX_SEATS = 25;

const STRIPE = 'https://api.stripe.com/v1';
const TOLERANCE = 300;

/** What the portal charges a month for this many advisors, in cents. Null past the cap. */
export function monthlyCents(seats) {
  const n = Math.max(1, Math.trunc(Number(seats) || 1));
  if (n <= 10) return n * 2900;
  if (n <= MAX_SEATS) return 30000;
  return null;
}

/** Billing is only on once there is a key and a price to put on the checkout. */
export function billingReady(env) {
  return Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_PRICE_FULL);
}

// ---------------------------------------------------------------------------
// Talking to Stripe
// ---------------------------------------------------------------------------

/** Stripe wants nested form fields, a[b][0][c]=1, rather than JSON. */
function formFields(params, prefix = '', out = []) {
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((x, i) => {
        if (x && typeof x === 'object') formFields(x, `${key}[${i}]`, out);
        else out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(x)}`);
      });
    } else if (typeof v === 'object') {
      formFields(v, key, out);
    } else {
      out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
    }
  }
  return out;
}

async function stripe(env, method, path, params) {
  const res = await fetch(`${STRIPE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: method === 'GET' ? undefined : formFields(params).join('&'),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = (data && data.error && data.error.message) || `Stripe answered ${res.status}.`;
    throw new Error(message);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Hearing from Stripe
// ---------------------------------------------------------------------------

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Did this request really come from Stripe?
 *
 * The header carries a timestamp and one or more signatures: an HMAC of
 * "timestamp.body" under the signing secret. The timestamp is checked as well,
 * so a captured request cannot be replayed next week. The body must be the raw
 * text that arrived: parsing it first and signing the result would not match.
 */
export async function verifySignature(raw, header, secret, at = now()) {
  if (!header || !secret) return false;
  let t = null;
  const signatures = [];
  for (const piece of String(header).split(',')) {
    const at2 = piece.indexOf('=');
    if (at2 < 0) continue;
    const k = piece.slice(0, at2).trim();
    const v = piece.slice(at2 + 1).trim();
    if (k === 't') t = v;
    if (k === 'v1') signatures.push(v);
  }
  if (!t || !signatures.length) return false;
  if (!Number.isFinite(Number(t)) || Math.abs(at - Number(t)) > TOLERANCE) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${raw}`)));
  const hex = [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
  return signatures.some((s) => sameBytes(s, hex));
}

/** Stripe has a longer list of states than this portal needs. */
function statusOf(stripeStatus) {
  switch (stripeStatus) {
    case 'active':
    case 'trialing':
      return 'active';
    case 'past_due':
    case 'unpaid':
      return 'past_due';
    case 'canceled':
    case 'incomplete_expired':
      return 'canceled';
    default:
      return null;
  }
}

async function agencyFor(env, { agencyId, customerId }) {
  const columns = 'id, plan, billing_status, past_due_since, stripe_customer_id, stripe_subscription_id, name';
  if (agencyId) {
    const a = await env.DB.prepare(`SELECT ${columns} FROM agencies WHERE id = ?`).bind(agencyId).first();
    if (a) return a;
  }
  if (customerId) {
    return env.DB.prepare(`SELECT ${columns} FROM agencies WHERE stripe_customer_id = ?`)
      .bind(customerId).first();
  }
  return null;
}

/** Somebody to put the activity line under: the agency's owner, since a webhook is nobody. */
async function ownerOf(env, agencyId) {
  const row = await env.DB.prepare(
    "SELECT id FROM users WHERE agency_id = ? AND role = 'admin' AND status = 'active' ORDER BY created_at ASC LIMIT 1"
  ).bind(agencyId).first();
  return row ? row.id : null;
}

async function note(env, agency, kind, subject, meta) {
  const owner = await ownerOf(env, agency.id);
  if (owner) await db.logActivity(env, owner, kind, subject, meta);
}

/** The agency is paid up: live, unlocked, and out of any grace period. */
async function switchOn(env, agency, fields = {}) {
  const ts = now();
  await env.DB.prepare(
    `UPDATE agencies SET plan = 'live', trial_ends_at = NULL, locked_at = NULL, trial_reminded = NULL,
            billing_status = 'active', past_due_since = NULL,
            stripe_customer_id = COALESCE(?, stripe_customer_id),
            stripe_subscription_id = COALESCE(?, stripe_subscription_id),
            stripe_item_id = COALESCE(?, stripe_item_id),
            seats_billed = COALESCE(?, seats_billed),
            paid_through = COALESCE(?, paid_through),
            updated_at = ?
      WHERE id = ?`
  ).bind(fields.customer || null, fields.subscription || null, fields.item || null,
         fields.seats ?? null, fields.paidThrough ?? null, ts, agency.id).run();
}

/** What an event changes. Unknown events are fine and change nothing. */
async function applyEvent(env, event) {
  const obj = (event.data && event.data.object) || {};

  if (event.type === 'checkout.session.completed') {
    if (obj.mode !== 'subscription') return;
    const agency = await agencyFor(env, {
      agencyId: obj.client_reference_id || (obj.metadata && obj.metadata.agency_id),
      customerId: obj.customer,
    });
    if (!agency) return;
    const wasPaying = agency.billing_status === 'active';
    await switchOn(env, agency, { customer: obj.customer, subscription: obj.subscription });
    await note(env, agency, 'billing.subscribed', 'Subscribed', { agency: agency.id });
    if (!wasPaying) {
      await sendSubscribedEmail(env, { agencyName: agency.name, email: obj.customer_details && obj.customer_details.email })
        .catch(() => {});
    }
    return;
  }

  if (event.type === 'customer.subscription.created' || event.type === 'customer.subscription.updated'
      || event.type === 'customer.subscription.deleted') {
    const agency = await agencyFor(env, {
      agencyId: obj.metadata && obj.metadata.agency_id,
      customerId: obj.customer,
    });
    if (!agency) return;
    const status = event.type === 'customer.subscription.deleted' ? 'canceled' : statusOf(obj.status);
    if (!status) return;
    // A cancelled subscription that is not the one on file is an old one being
    // tidied up after the agency subscribed again. It must not lock them.
    if (status === 'canceled' && agency.stripe_subscription_id && obj.id !== agency.stripe_subscription_id) return;

    const item = obj.items && obj.items.data && obj.items.data[0];
    const paidThrough = Number(obj.current_period_end) || (item && Number(item.current_period_end)) || null;

    if (status === 'active') {
      await switchOn(env, agency, {
        customer: obj.customer, subscription: obj.id, item: item && item.id,
        seats: item && item.quantity, paidThrough,
      });
    } else if (status === 'past_due') {
      await env.DB.prepare(
        `UPDATE agencies SET billing_status = 'past_due', past_due_since = COALESCE(past_due_since, ?),
                stripe_customer_id = COALESCE(stripe_customer_id, ?), updated_at = ? WHERE id = ?`
      ).bind(now(), obj.customer || null, now(), agency.id).run();
    } else {
      await env.DB.prepare(
        "UPDATE agencies SET billing_status = 'canceled', updated_at = ? WHERE id = ?"
      ).bind(now(), agency.id).run();
      await note(env, agency, 'billing.canceled', 'Subscription ended', { agency: agency.id });
    }
    return;
  }

  if (event.type === 'invoice.paid') {
    const agency = await agencyFor(env, { customerId: obj.customer });
    if (!agency) return;
    const line = obj.lines && obj.lines.data && obj.lines.data[0];
    await env.DB.prepare(
      `UPDATE agencies SET billing_status = 'active', past_due_since = NULL, locked_at = NULL,
              paid_through = COALESCE(?, paid_through), updated_at = ? WHERE id = ?`
    ).bind((line && line.period && Number(line.period.end)) || null, now(), agency.id).run();
    return;
  }

  if (event.type === 'invoice.payment_failed') {
    const agency = await agencyFor(env, { customerId: obj.customer });
    if (!agency) return;
    await env.DB.prepare(
      `UPDATE agencies SET billing_status = 'past_due', past_due_since = COALESCE(past_due_since, ?),
              updated_at = ? WHERE id = ?`
    ).bind(now(), now(), agency.id).run();
    await note(env, agency, 'billing.failed', 'A payment failed', { agency: agency.id });
  }
}

export async function handleStripeWebhook(request, env) {
  if (!env.STRIPE_WEBHOOK_SECRET) return json({ error: 'Billing is not switched on.' }, 503);

  const raw = await request.text();
  if (!(await verifySignature(raw, request.headers.get('stripe-signature'), env.STRIPE_WEBHOOK_SECRET))) {
    return json({ error: 'That did not come from Stripe.' }, 400);
  }
  let event;
  try { event = JSON.parse(raw); } catch { return badRequest('Not JSON.'); }
  if (!event || !event.id || !event.type) return badRequest('Not an event.');

  // Once per event id. Stripe sends again when it was not answered in time,
  // and a second "payment failed" must not move the grace clock.
  const first = await env.DB.prepare(
    'INSERT OR IGNORE INTO stripe_events (id, kind, received_at) VALUES (?, ?, ?)'
  ).bind(event.id, event.type, now()).run();
  if (!first.meta || first.meta.changes === 0) return json({ ok: true, duplicate: true });

  try {
    await applyEvent(env, event);
  } catch (e) {
    // Forgotten again so that Stripe's retry is processed rather than skipped
    // as a duplicate of something that never took effect.
    await env.DB.prepare('DELETE FROM stripe_events WHERE id = ?').bind(event.id).run().catch(() => {});
    throw e;
  }
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// The screens
// ---------------------------------------------------------------------------

async function readAgency(env, agencyId) {
  const wide = `SELECT id, name, plan, product, trial_ends_at, billing_status, past_due_since, paid_through,
                       stripe_customer_id, stripe_subscription_id, seats_billed
                  FROM agencies WHERE id = ?`;
  try {
    return await env.DB.prepare(wide).bind(agencyId).first();
  } catch {
    // Before the billing migration is applied. Billing reads as never started.
    return env.DB.prepare('SELECT id, name, plan, trial_ends_at FROM agencies WHERE id = ?')
      .bind(agencyId).first();
  }
}

async function seatsIn(env, agencyId) {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM users WHERE agency_id = ? AND status = 'active'"
  ).bind(agencyId).first();
  return Math.max(1, (row && row.n) || 1);
}

export async function handleBillingStatus(request, env) {
  const { user, response } = await requireUser(request, env, { allowLocked: true });
  if (response) return response;

  const agency = user.agency_id ? await readAgency(env, user.agency_id) : null;
  if (!agency) return json({ enabled: false, plan: null });

  const seats = await seatsIn(env, agency.id);
  const lapse = lapseState(agency);
  return json({
    enabled: billingReady(env),
    isOwner: isAdmin(user),
    portalOwner: Boolean(user.platform_owner) || agency.id === 'agency-house',
    agencyName: agency.name,
    plan: agency.plan,
    product: agency.product || 'full',
    trialEndsAt: agency.trial_ends_at || null,
    billingStatus: agency.billing_status || null,
    pastDueSince: agency.past_due_since || null,
    graceEndsAt: lapse.graceEndsAt,
    locked: lapse.locked,
    graceDays: GRACE_DAYS,
    paidThrough: agency.paid_through || null,
    hasCustomer: Boolean(agency.stripe_customer_id),
    seats,
    maxSeats: MAX_SEATS,
    monthlyCents: monthlyCents(seats),
  });
}

export async function handleBillingCheckout(request, env) {
  const { user, response } = await requireAdmin(request, env, { allowLocked: true });
  if (response) return response;
  if (!billingReady(env)) {
    return json({ error: 'Billing is not switched on yet. Get in touch and we will switch your account on.' }, 503);
  }

  const agency = await readAgency(env, user.agency_id);
  if (!agency) return badRequest('Your account is not part of an agency yet.');
  if (user.platform_owner || agency.id === 'agency-house') {
    return badRequest('This is the portal owner’s own agency. There is nothing to pay.');
  }
  if (agency.billing_status === 'active' || agency.billing_status === 'past_due') {
    return badRequest('This agency already has a subscription. Use Manage billing to change it.');
  }

  const seats = await seatsIn(env, agency.id);
  if (seats > MAX_SEATS) {
    return badRequest(`Past ${MAX_SEATS} advisors the price is a conversation. Get in touch and we will set it up.`);
  }

  const base = String(env.APP_URL || new URL(request.url).origin).replace(/\/+$/, '');
  try {
    const session = await stripe(env, 'POST', '/checkout/sessions', {
      mode: 'subscription',
      line_items: [{ price: env.STRIPE_PRICE_FULL, quantity: seats }],
      client_reference_id: agency.id,
      customer: agency.stripe_customer_id || undefined,
      customer_email: agency.stripe_customer_id ? undefined : user.email,
      subscription_data: { metadata: { agency_id: agency.id } },
      metadata: { agency_id: agency.id },
      allow_promotion_codes: 'true',
      success_url: `${base}/admin/billing?subscribed=1`,
      cancel_url: `${base}/admin/billing`,
    });
    return json({ url: session.url });
  } catch (e) {
    return json({ error: `Stripe could not start the checkout: ${e.message}` }, 502);
  }
}

export async function handleBillingPortal(request, env) {
  const { user, response } = await requireAdmin(request, env, { allowLocked: true });
  if (response) return response;
  if (!env.STRIPE_SECRET_KEY) return json({ error: 'Billing is not switched on yet.' }, 503);

  const agency = await readAgency(env, user.agency_id);
  if (!agency || !agency.stripe_customer_id) return badRequest('This agency has not subscribed yet.');

  const base = String(env.APP_URL || new URL(request.url).origin).replace(/\/+$/, '');
  try {
    const session = await stripe(env, 'POST', '/billing_portal/sessions', {
      customer: agency.stripe_customer_id,
      return_url: `${base}/admin/billing`,
    });
    return json({ url: session.url });
  } catch (e) {
    return json({ error: `Stripe could not open the billing page: ${e.message}` }, 502);
  }
}

/**
 * Keep what is billed in step with how many advisors there are.
 *
 * Run from the cron instead of from every place an advisor can be added or
 * removed, because there are a dozen of those and one of them would be
 * forgotten. An agency billed for ten that now has twelve is corrected within
 * minutes, and Stripe prorates the difference.
 */
export async function syncSeats(env) {
  if (!env.STRIPE_SECRET_KEY) return { skipped: true };
  let rows;
  try {
    ({ results: rows } = await env.DB.prepare(
      `SELECT id, stripe_item_id, seats_billed FROM agencies
        WHERE stripe_item_id IS NOT NULL AND billing_status IN ('active', 'past_due') LIMIT 200`
    ).all());
  } catch {
    return { skipped: true };
  }
  let changed = 0;
  for (const a of rows || []) {
    const seats = Math.min(await seatsIn(env, a.id), MAX_SEATS);
    if (seats === a.seats_billed) continue;
    try {
      await stripe(env, 'POST', `/subscription_items/${encodeURIComponent(a.stripe_item_id)}`, {
        quantity: seats, proration_behavior: 'create_prorations',
      });
      await env.DB.prepare('UPDATE agencies SET seats_billed = ?, updated_at = ? WHERE id = ?')
        .bind(seats, now(), a.id).run();
      changed += 1;
    } catch (e) {
      console.error('syncSeats', a.id, e.message);
    }
  }
  return { changed };
}

