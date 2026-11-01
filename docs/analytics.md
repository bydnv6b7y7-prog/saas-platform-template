# PostHog analytics and attribution

**English** | [简体中文](analytics.zh-CN.md)

PostHog is the analytics destination for browser behavior, acquisition attribution, signup, and subscription conversion. Browser and server events use the same project token and the same Better Auth `user.id` after identification.

## Source-of-truth invariants

| Concern | Source of truth | Persistence and timing |
| --- | --- | --- |
| Browser privacy policy | Server-resolved `opt_in` / `opt_out` policy from trusted `CF-IPCountry`; explicit deployment mode and unknown countries fail closed to `opt_in` | The browser receives only the policy class, never the country. The strict-country list is runtime-configurable and must be reviewed by product/legal. |
| Browser preference | `northwind.analytics-consent.v1` in local storage, overridden by GPC/DNT | An explicit choice always overrides the regional default. In `opt_in`, `pending` sends nothing; in `opt_out`, `pending` permits capture. `denied` and browser privacy signals always send nothing. Withdrawal stops capture and clears the PostHog browser identity. |
| Anonymous acquisition | `posthog-js` browser identity | UTM/referrer properties persist in PostHog browser storage only while analytics is enabled and before authentication. Activity collected while disabled is neither sent nor replayed later. |
| Approximate geography | Browser requests may be enriched by PostHog; server events set `disableGeoip: true`; the PostHog project owns raw-IP discard | Derived browser geography may be retained for analysis, but the raw client address must be discarded at ingestion. Enabling discard is prospective and does not delete historical IP data. |
| Account identity | Better Auth `user.id` | `identify(user.id)` merges pre-login browser activity; logout calls `reset()`. Email is never the distinct ID. |
| Signup | Better Auth user-create database hook | `user_signed_up` is emitted once from the server for email and social signup. |
| Checkout intent | Pricing action in the browser | `billing_checkout_started` means the authenticated client requested Hosted Checkout; it is not revenue. |
| Subscription activation | Verified Stripe webhook through Better Auth | `subscription_started` is emitted only after Stripe confirms the subscription. Stripe event time and a deterministic UUID make webhook retries idempotent. |
| Cancellation / end | Verified Stripe webhook through Better Auth | Scheduled cancellation and actual subscription end remain separate events. |

Analytics failures never fail authentication, billing projection, or Stripe webhook handling. PostHog is a downstream observer, not an authorization or billing authority.

## Event contract

The shared type contract lives in `packages/analytics/src/index.ts`. A product adds its own events by declaration merging into `ProductAnalyticsEvents` from its own code (`apps/web/src/product/analytics.ts`), so they are typed like platform events without the platform naming them.

| Event | Owner | Important properties |
| --- | --- | --- |
| `user_signed_up` | Auth server | `auth_method` |
| `assistant_opened` | Web | `source`, sanitized `path` |
| `billing_interval_selected` | Web | `billing_interval` |
| `billing_checkout_started` | Web | plan, interval, USD amount in cents |
| `billing_checkout_failed` | Web | bounded failure category; never a raw error message |
| `subscription_started` | Stripe webhook | plan, interval, status, catalog price in minor units, currency |
| `subscription_cancel_scheduled` | Stripe webhook | plan, interval, status |
| `subscription_ended` | Stripe webhook | plan, interval, status |

While analytics is enabled under the effective policy and user preference, the browser explicitly captures `$pageview` and campaign properties on path changes. Page-leave and generic autocapture events are disabled in favor of the shared, typed event contract. The SDK's automatic `$opt_in` event is suppressed because an enabled technical capture state does not necessarily mean the visitor explicitly consented. Session replay, exception capture, surveys, heatmaps, dead-click capture, arbitrary element attributes, and page text are disabled. Every URL query string, hash, and embedded credential is removed before an event is sent, and share-token paths are redacted. This includes PostHog's nested `$initial_person_info` URL and referrer fields, not only top-level URL properties. Browser events intentionally allow PostHog to derive approximate geographic properties from the connection address before the project discards that raw address. Campaign attribution still works because the SDK extracts UTM values into dedicated campaign properties before the event sanitizer runs.

The browser choice controls optional device analytics. Server-side signup and Stripe subscription lifecycle events are generated independently from authoritative account and billing systems and use no browser storage. Keep that distinction explicit in the privacy policy; do not describe the browser switch as an account-wide deletion or suppression control.

## Regional policy

`ANALYTICS_PRIVACY_MODE` is a server-only runtime setting for the web process:

- `opt_in` (safe default): analytics stays off until the visitor allows it.
- `opt_out`: analytics starts enabled, with GPC/DNT and the persistent privacy control able to disable it.
- `geo`: the server reads Cloudflare's `CF-IPCountry`. Countries in `ANALYTICS_OPT_IN_COUNTRIES` use `opt_in`; all other valid countries use `opt_out`. Missing, `XX`, or malformed values use `opt_in`.

The default strict list is EEA + UK + Switzerland + Canada and is a conservative engineering baseline, not an exhaustive legal conclusion. Product/legal owns changes to `ANALYTICS_OPT_IN_COUNTRIES`. A partially invalid override is rejected rather than silently weakening the strict list; the root loader then falls back to `opt_in`. The policy is resolved once per loaded document; a full reload re-evaluates it without adding a policy request to every client-side route transition. Production may use `geo` only while Cloudflare IP Geolocation is enabled and the origin accepts web traffic only from trusted Cloudflare paths; otherwise use `opt_in`. Responses vary on `CF-IPCountry`, and PostHog never receives the country value from this policy resolver.

## Configuration

Use the same US Cloud project token in both runtimes:

```dotenv
# apps/web/.env or Web image build arguments
VITE_POSTHOG_PROJECT_TOKEN=phc_xxx
VITE_POSTHOG_HOST=https://ingest.northwind.dev

# apps/server/.env or API runtime environment
POSTHOG_PROJECT_TOKEN=phc_xxx
POSTHOG_HOST=https://us.i.posthog.com
```

Browser events use the first-party Cloudflare Worker as `api_host`; the SDK keeps `ui_host=https://us.posthog.com` so links, the toolbar, and replay tooling remain associated with the US Cloud project. The Worker must forward the trusted Cloudflare client address as `X-Forwarded-For` so PostHog derives user geography rather than proxy geography, strip inbound cookies, and preserve the documented `/static/*`, `/array/*`, and API routing behavior. Server events bypass the Worker and go directly to the US ingestion host. The two runtimes share a project token and identity contract, but intentionally do not share an ingestion host.

`list_price_minor` is catalog price context in the currency's minor unit; it is not recognized revenue. Actual revenue must come from a successful payment source such as a paid Stripe invoice or a PostHog Stripe source.

The token may remain unset for local development and tests. A formal production release must fail closed during build, provisioning, or readiness validation when either runtime token or its intended host is absent or invalid; production must never silently ship with analytics disabled. After a correctly configured release is running, SDK loading errors, blocked browser requests, proxy failures, and PostHog outages remain non-blocking and must never interrupt product flows. Use the same `POSTHOG_PROJECT_TOKEN` repository secret for both runtimes, `VITE_POSTHOG_HOST` as the browser proxy repository variable, and `POSTHOG_HOST` as the direct server-ingestion repository variable. Run the Dokploy provisioner after initial setup and every server token or host rotation; browser token or proxy changes require a new Web image build. Production smoke checks verify the API host through readiness metadata and the browser proxy through the Web CSP without sending synthetic events to PostHog.

Before production traffic, product/legal must confirm the PostHog data-processing agreement, selected project region/ingestion host, and any required international-transfer safeguards. In PostHog project settings, enable **Discard client IP data**, keep GeoIP enrichment enabled for browser events, and set an approved retention period. Browser code intentionally permits GeoIP enrichment so PostHog can derive approximate country, region, city, and time-zone properties before discarding the raw client address. Server-generated events keep `disableGeoip: true` because their network address belongs to application infrastructure, not the user. Data-subject deletion requests must include the PostHog person and associated events keyed by the internal Better Auth user ID. Account deletion now schedules this automatically (best-effort) when `POSTHOG_PERSONAL_API_KEY` and `POSTHOG_PROJECT_ID` are both configured; without them the person deletion step is skipped and logged — set both variables to complete deletion coverage.

## Initial PostHog views

After the first production events arrive, configure:

1. Conversion goals for `user_signed_up` and `subscription_started`.
2. A funnel: pricing `$pageview` → `billing_checkout_started` → `subscription_started`.
3. Signup and subscription breakdowns by initial UTM source, initial referring domain, latest UTM source, plan, and billing interval.
4. A retention view based on identified users returning to rankings or opening Northwind AI.

The connected PostHog project currently reports in UTC. Keep dashboard bucketing in UTC until the business reporting timezone is explicitly changed.

Official references: [JavaScript Web SDK](https://posthog.com/docs/libraries/js), [Cloudflare reverse proxy](https://posthog.com/docs/advanced/proxy/cloudflare), [discarding IP addresses at project level](https://posthog.com/docs/privacy/data-storage#discarding-ip-addresses-at-project-level), [identifying users](https://posthog.com/docs/getting-started/identify-users), [UTM segmentation](https://posthog.com/docs/data/utm-segmentation), [Node.js SDK](https://posthog.com/docs/libraries/node), and [event deduplication](https://posthog.com/docs/data/events#event-deduplication).
