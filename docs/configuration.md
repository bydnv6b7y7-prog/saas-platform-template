# Configuration: who owns each variable and where it takes effect

**English** | [简体中文](configuration.zh-CN.md)

Environment variables handle credentials and deployment; day-to-day operational values (assistant quotas and so on) are changed in Admin → Settings, with an audit trail.
Every variable is validated by a zod contract (`packages/env/src/*`); a missing or malformed value makes startup fail outright instead of running in a broken state.
`bun run doctor` checks each item in the tables below and tells you the next step.

## 1. Local development (`apps/server/.env`, `apps/web/.env`)

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | Yes | PostgreSQL 18 started by `bun run db:start` |
| `BETTER_AUTH_SECRET` | Yes | ≥ 32 characters: `openssl rand -base64 32` |
| `BETTER_AUTH_URL` / `CORS_ORIGIN` | Yes | Local addresses of the API and Web |
| `EMAIL_DEV_MAILPIT_URL` | Recommended locally | Delivers verification codes to Mailpit (<http://localhost:8025>); must not be set in production |
| `COPILOT_MODEL_PROVIDER` + matching key | Needed for the assistant | `deepseek` / `openrouter` / `openai-compatible` (`LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL`); see [AI assistant](./ai-assistant.md) |
| `APP_STORE_ENABLED` | Yes | Template default is `false`; change to `true` once you have App Store Connect credentials, see below |
| `ADMIN_USER_IDS` | No | After signing up, get the id with `bun run admin:lookup you@example.com` |
| `VITE_SERVER_URL` / `VITE_WEB_URL` / `VITE_BRAND_NAME` | Yes (Web) | Injected into the browser at build time |

## 2. Optional integrations (set the whole group to enable, leave the whole group empty to disable)

| Integration | Variables | Docs |
| --- | --- | --- |
| Email (production) | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_EMAIL_API_TOKEN`, `EMAIL_FROM` | [Email verification](./email-verification.md) |
| Stripe subscriptions | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO_MONTHLY`, `STRIPE_PRICE_PRO_YEARLY` | [Subscriptions](./subscriptions.md); locally, `bun run dev:stripe` forwards webhooks |
| Object storage (R2) | `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` (`R2_REGION`); for browser-direct uploads also run `bun run storage:cors` | [Object storage](./object-storage.md) |
| PostHog | `POSTHOG_PROJECT_TOKEN` (server), `VITE_POSTHOG_PROJECT_TOKEN` (browser) | [Analytics](./analytics.md) |
| Google / GitHub / Apple sign-in | `GOOGLE_*`, `GITHUB_*`, `APPLE_*` | [Native and Web sign-in](./native-ios-auth.md) |
| App Store in-app purchases | `APP_STORE_ISSUER_ID`, `APP_STORE_KEY_ID`, `APP_STORE_PRIVATE_KEY_BASE64`, `APP_STORE_ENVIRONMENTS` | [App Store in-app purchases](./app-store-subscriptions.md) |

## 3. Project identity (in code, not environment variables)

| Content | File |
| --- | --- |
| iOS App: name, Bundle ID, App Apple ID, subscription group, products and entitlements, rating triggers, feedback scenarios | `packages/env/src/apple-application.ts` |
| Browser-side PostHog reverse proxy address | `packages/env/src/posthog-hosts.ts` |
| Brand name | `VITE_BRAND_NAME` (Web build), `PRODUCTION_BRAND_NAME` (release) |
| Brand graphics | `apps/web/public/brand/*` |

When the template is exported, these values come from the export config (`.template.json`). Without an iOS App, keep the placeholder values and leave `APP_STORE_ENABLED=false`.

## 4. Runtime settings in Admin → Settings

Assistant quotas (Free/Pro per 5 minutes and per UTC day) are stored in the `operations` scope of `runtime_settings`:
before the first save, the contract defaults apply; after saving, the database snapshot is authoritative, and every change carries a revision number and an audit entry.

A product registers its own runtime settings as a new scope with the same mechanism:

1. `packages/product/src/<name>-settings.ts`: the zod `strictObject` contract and defaults;
2. `packages/product/src/routers/<name>-settings.ts`: `createSettingsStore(db, definition)` and
   `createSettingsRouter(definition, store)`, mounted at `config.<name>` in `router.ts`;
3. Add an entry to `productAdminSettings` in `apps/web/src/product/index.ts`, and use `RuntimeSettingsPanel` in the component.

## 5. Deployment

Production variables go in `.env.dokploy.local`; see [Deployment](./deployment.md).
