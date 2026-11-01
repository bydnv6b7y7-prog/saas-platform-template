# Subscriptions and Stripe Runbook

**English** | [简体中文](subscriptions.zh-CN.md)

> Status: Current · 2026-08-30
> Implementation: the official Better Auth 1.7.2 Stripe plugin + Stripe Node 22.6.0 + Hosted Checkout/Portal.

## 1. Authority boundaries

Stripe is the external authority for payments and the subscription lifecycle; the Better Auth plugin verifies Stripe webhooks and syncs the state into
PostgreSQL. The app only reads this owner-scoped projection to decide entitlements; it does not query Stripe synchronously on every request, and it does not grant access just because the browser
returned to the success URL.

Admin permissions are a separate source of app access, not a Stripe subscription. Admins recognized by the Better Auth Admin Plugin get
the Pro product allowance directly, but are still subject to the same Pro runtime limits; the app does not fabricate a subscription record or ask for payment.

Official references:

- [Better Auth Admin plugin](https://better-auth.com/docs/plugins/admin): admin roles and the bootstrap user id;
- [Better Auth Stripe plugin](https://better-auth.com/docs/plugins/stripe): the official plugin, client, schema, webhook and Portal;
- [Better Auth hooks](https://better-auth.com/docs/concepts/hooks) and
  [rate limiting](https://better-auth.com/docs/concepts/rate-limit): server-side pre-checks, endpoint rules, and shared storage when scaling out;
- [Stripe products and prices](https://docs.stripe.com/products-prices/how-products-and-prices-work): the authoritative Product/Price model;
- [Stripe subscriptions integration](https://docs.stripe.com/billing/subscriptions/build-subscriptions): Hosted Checkout, webhook provisioning and Portal;
- [Stripe subscription webhooks](https://docs.stripe.com/billing/subscriptions/webhooks): asynchronous state changes and access control;
- [Stripe API keys](https://docs.stripe.com/keys): secret/restricted keys are used only on the server and in a secret store;
- [Stripe advanced fraud detection](https://docs.stripe.com/disputes/prevention/advanced-fraud-detection): Hosted Checkout/Stripe.js may load hCaptcha based on risk signals;
- [Better Auth 1.7 upgrade](https://better-auth.com/docs/guides/1-7-upgrade-guide): issuer/accountId identity migration and maintenance window requirements.

## 2. One-time Stripe Dashboard setup

### Product and Price

Create one `Northwind Pro` Product representing the single entitlement, and under that Product create two fixed recurring Prices:

| Environment variable | Stripe interval | Better Auth plan |
| --- | --- | --- |
| `STRIPE_PRICE_PRO_MONTHLY` | month × 1 | `pro-monthly` |
| `STRIPE_PRICE_PRO_YEARLY` | year × 1 | `pro-yearly` |

Both Prices must be active, on the same Product, in USD, with a fixed positive integer amount. After the service starts, the catalog reads these attributes from Stripe and
validates them; the frontend does not store prices and never receives Price IDs.

Do not create multiple Products for different billing periods of the same entitlement. Price and period are attributes of a Price; a Product represents what is being sold.

The current self-serve packaging has only two entitlement tiers:

| Tier | Price | Entitlement boundary |
| --- | --- | --- |
| Free | $0 | Latest and historical charts, data freshness and coverage, private conversation history, and 5 full Northwind AI requests per day |
| Northwind Pro | $20/month or $200/year | Everything in Free, plus 100 Northwind AI requests per day |

Yearly billing is shown in the UI as `$16.67/month`, and must also clearly state `$200 billed yearly` and the 17% saving. Weekly billing is no longer
sold; the old Price in Stripe stays inactive and is no longer part of the app config or new Checkouts.

### Webhook

Create the endpoint:

```text
https://<API_DOMAIN>/api/auth/stripe/webhook
```

Subscribe to at least:

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`

Save the endpoint's own signing secret as `STRIPE_WEBHOOK_SECRET`. It is not an API key, and the test and production endpoints
each have their own secret. Signature verification and event handling are done by the official Better Auth plugin; no second webhook handler is written.

Local Sandbox uses the Stripe CLI to forward the same set of events; the signing secret in `apps/server/.env` must come from the current CLI
profile. The project provides an entry point:

```sh
bun run dev:stripe
```

It forwards events to `http://localhost:3000/api/auth/stripe/webhook`. During local development it must run alongside `bun run dev`.

### Customer Portal

Configure the Portal separately in Sandbox and Live mode: branding, invoice history, payment method update, cancel at period
end, and the monthly and yearly Pro Prices that customers may switch between. The app only creates short-lived Portal sessions and does not replicate a billing management UI.

Hosted Checkout lives at `checkout.stripe.com`. Stripe may load hCaptcha on that hosted page as an advanced fraud
signal; normal users usually see no interactive challenge, and one appears on the payment page only when risk controls require it. It is not in the Northwind
source code or in a separate settings menu in the Stripe Dashboard, and it should not be integrated separately or turned off by default. When troubleshooting, filter for `hcaptcha` in the browser Network panel on the Checkout
page, and do not mistake an automated browser being challenged for an app failure.

### Secret key

Prefer a restricted key; in the current Stripe Dashboard the minimum permissions are Customers write, Products read, Prices read,
Subscriptions write, Checkout Sessions write, Customer Portal write. Webhook signatures are verified locally, so the runtime key does not get
Webhook Endpoints permission. If the platform has a stable egress IP, add an IP allowlist as well. Rotate regularly and review the Stripe API logs.

## 3. Server environment variables

Leaving the whole group empty disables it locally; filling in only some of them fails fast at startup:

```dotenv
STRIPE_SECRET_KEY=rk_live_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx
STRIPE_PRICE_PRO_MONTHLY=price_xxx
STRIPE_PRICE_PRO_YEARLY=price_xxx
```

Production values go in the Git-ignored `.env.dokploy.local` (or process environment variables of the same names), are injected into Dokploy by the provisioning script, and reach only the API
container; the local `apps/server/.env` always keeps Sandbox values. The provisioning script rejects test/claimable keys, and the deployment smoke test
also checks `billing.livemode=true` in `/readyz` again to prevent a config regression. Hosted Checkout is used, so the browser does not need a
publishable key.

On the first switch from Sandbox to Live, migration `0011_stripe_live_cutover` only terminates abandoned Checkout placeholder records that never produced a Stripe Subscription
and whose Customer ID exactly matches the owning user's, and at the same time clears that user's old Sandbox Customer
ID. Existing Stripe Subscriptions, other users, and any record that cannot be reliably identified are left untouched; afterwards Better Auth creates a new Live Customer
on the user's first Live Checkout.

## 4. Status and entitlement policy

| Stripe status | Pro entitlement | User action | New Checkout allowed |
| --- | --- | --- | --- |
| `active`, `trialing` | Yes | Normal use; can open Portal | No |
| `past_due`, `unpaid`, `paused`, or `incomplete` that already has a Stripe Subscription ID | No | Fix it in Portal | No |
| Local `incomplete` Checkout placeholder with no Stripe Subscription ID yet | No | Start Checkout again | Yes |
| Unknown non-terminal status | No (fail closed) | Portal / manual check | No |
| `canceled`, `incomplete_expired` | No | Can resubscribe | Yes |

When `cancel_at_period_end=true`, the Stripe status stays active until the actual end, so the entitlement lasts until `periodEnd`. Better
Auth uses an intermediate redirect before the final success URL to wait for the webhook projection; the browser still only triggers a re-read and never writes
or grants permissions itself.

`GET /api/billing/status` queries only by the `user.id` of the Better Auth session and does not accept a client resource ID; the response does not include the
Customer ID, Subscription ID, resourceId or internal metadata. If reading the status fails, Pricing disables Checkout
to avoid creating duplicate subscriptions.

The AG-UI Runtime reads the same subscription projection on the server and maps the signed-in user to the Free or Pro allowance; the custom
assistant thread endpoints are open to all signed-in users. The entitlement source is decided in the order `admin → subscription → free`: admins get
the Pro allowance without creating a Stripe subscription; subscribers must be granted access by the webhook projection's `grantsAccess=true`;
all other users use the Free allowance. By default Free allows at most 5 runs/5 minutes and 5 runs/UTC day, and Pro allows at most 10 runs/5
minutes and 100 runs/UTC day. Only agent runs started by the user reserve allowance, and failed or cancelled runs release their reservation.
Counts are written to the existing PostgreSQL `usage_buckets`, keyed by an irreversible user hash, consistent across instances, and not dependent on in-process counters.

Allowances are maintained in Admin → Settings (`/admin/config`). Every new run and every usage query reads the same
database config, while a run in progress keeps using its original allowance snapshot; changing an allowance does not clear existing usage. Before the first save, the four
`ASSISTANT_*_RUN_LIMIT_*` environment variables are still honored, with defaults from the shared contract. After the first actual save, all allowances are owned by the database.

The config snapshot and its audit of editor, time, version, and before/after values use the new migration `0013_operational_settings.sql`;
usage counts keep reusing `usage_buckets`. For defaults, concurrent saves, and release steps see [Configuration and Admin Settings](./configuration.md).

Better Auth's production default rate limit stays enabled; creating Checkout and Portal sessions is additionally limited to 10 per source per
minute. `/subscription/upgrade` also has a server-side before hook: as long as a non-terminal subscription exists locally, a new Checkout is rejected,
and admins are rejected for new Checkouts too, so duplicate subscriptions or pointless payments cannot be created by bypassing the frontend. An existing real subscription can still be cancelled in Portal,
and an admin's product access does not end with that subscription. Dokploy currently runs a single long-lived API instance, so the official default in-memory counter is kept; before scaling
out horizontally, it must be switched to Better Auth's PostgreSQL or shared secondary storage. Webhooks are not subject to this custom rate limit, so that Stripe's legitimate
retries are not blocked.

## 5. Database changes and release

The admin access source reuses Better Auth's existing `role` / `ADMIN_USER_IDS` and the runtime projection and adds no tables or fields, so this policy
by itself needs neither `db:push` nor a new migration. The migration notes below apply only to a first-time install of the existing Stripe integration.

This release must use:

```sh
bun run db:migrate
```

Do not use `bun db:push`: shared/production databases need versioned, reviewable, repeatable SQL migrations.

Migration `0009_better_auth_stripe.sql` does all of the following:

- the `account.issuer` backfill and the `(issuer, accountId)` unique index required by Better Auth 1.7;
- `user.stripe_customer_id`;
- the official Better Auth Stripe `subscription` table and its query indexes.

Migration `0011_stripe_live_cutover.sql` handles only the one-time leftover placeholders from Sandbox → Live: it terminates `incomplete` rows that never received a
Stripe Subscription ID/period status and whose Customer ID exactly matches the owner, then clears
that owner's Sandbox Customer ID. Any real subscription, cross-user row, or row with ambiguous meaning is left unchanged.

Before going live, back up `user`/`account`, pause sign-in writes during a maintenance window, and first take an inventory:

```sql
SELECT provider_id, count(*) FROM account GROUP BY provider_id ORDER BY provider_id;
```

The migration only accepts credential, Google, GitHub and Apple, the providers this deployment actually enables. If any other provider exists the migration aborts; you must first
create an explicit mapping based on the trusted provider issuer and check for collisions, and users must not be merged by email.

## 6. Sandbox regression and Live acceptance

Every time billing logic changes, first complete the following in Stripe Sandbox:

1. A new user completes both a monthly and a yearly Checkout; after the webhook, the correct amount, period and active status are shown;
2. Clicking Pricing repeatedly only leads to Billing/Portal and does not create a second Subscription;
3. Switching period, updating the card, and setting period-end cancellation in Portal are all written back through webhooks;
4. Use a Stripe test card to cause a payment failure; the app revokes the entitlement, prompts the user to fix it, and blocks new Checkouts;
5. After a cancellation actually ends, the user can resubscribe; one user cannot read or manage another user's Subscription;
6. Replaying webhooks creates no duplicate records; a bad signature returns a failure; API logs show no keys, signatures or Customer IDs;
7. `bun test`, `bun run check-types`, `bun run build`, migration on an empty database, and migration idempotency all pass.

The Live baseline was verified on 2026-08-30: production `/readyz` reports `billing.configured=true` and
`billing.livemode=true`; the yearly entry point creates a Live `subscription` Checkout for USD 200/year; the acceptance
session was left unpaid and granted no entitlement. The production smoke test always requires configured + Live, to prevent a deployment from regressing to Sandbox.

The Live `Northwind Pro` Product currently has Stripe tax code `txcd_10701400` (Website Information
Services — Business Use). A product tax code is only a tax classification and does not mean automatic Stripe Tax is enabled.
Stripe Tax, promotion codes, trials, seats, cancelling subscriptions when a user is deleted, and self-built dunning emails are still not turned on. Once the tax
registration locations and obligations are confirmed, review it separately following [Stripe Tax for Checkout](https://docs.stripe.com/tax/checkout);
do not let technical defaults stand in for a tax decision.
