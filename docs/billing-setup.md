# Switching on billing

Everything is built and sits dormant. Nothing charges anyone until the steps below are done.
Do them in Stripe **test mode** first, then repeat in live mode.

## 1. Apply the migration

Run `migrations/0130_billing.sql` in the D1 console for `trip-vara` (Workers & Pages > D1 > trip-vara > Console).
Until it is applied the code treats billing as never started, so nothing breaks, but nothing can be saved either.

## 2. Create the price in Stripe

Products > Add product. Name it "Trip Vara, per advisor". Pricing model **Graduated**, recurring monthly, USD.

| First unit | Last unit | Per unit | Flat fee |
|---|---|---|---|
| 1 | 10 | $29.00 | none |
| 11 | 25 | $0.00 | $10.00 |
| 26 | and over | not for sale | |

That gives $29 for one advisor, $290 for ten, and $300 for anywhere from eleven to twenty five. Checkout refuses more than twenty five.
Copy the price id (it starts `price_`).

## 3. Turn on the customer page

Settings > Billing > Customer portal. Allow: update payment method, view invoices, cancel subscription (at end of billing period).
Turn on Stripe's emails for failed payments and upcoming renewals, so the agency hears from Stripe as well as the portal.

## 4. Add the webhook

Developers > Webhooks > Add endpoint.
URL: `https://tripvaratravel.com/api/stripe/webhook`
Events to send:
- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.paid`
- `invoice.payment_failed`

Copy the signing secret (it starts `whsec_`).

## 5. Give the Worker its three values

Worker `trip-vara` > Settings > Variables and Secrets:

| Name | Type | Value |
|---|---|---|
| `STRIPE_SECRET_KEY` | Secret | the secret key (`sk_test_...`, later `sk_live_...`) |
| `STRIPE_WEBHOOK_SECRET` | Secret | the `whsec_...` signing secret |
| `STRIPE_PRICE_FULL` | Text | the `price_...` id |

Never paste these in chat or commit them.

## 6. Try it

Start a demo with a fresh email, open Admin > Billing, press Subscribe, and pay with Stripe's test card `4242 4242 4242 4242`
(any future date, any CVC). Within a minute the page should say Subscribed.
Then, in Stripe, cancel the subscription and confirm the portal closes. Pay again and confirm it reopens.

## What happens when a payment fails

Stripe retries the card. The portal starts seven days of grace from the first failure: everything keeps working and the owner
sees a notice on Billing. After seven days the portal locks. It never deletes anything, and a successful payment switches it
back on. A cancelled subscription locks straight away, once the period already paid for has run out.

## Advisors added or removed

The number of advisors billed follows the number of active advisors in the agency, checked every few minutes. Stripe prorates the
difference.
