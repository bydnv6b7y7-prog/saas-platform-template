# Northwind platform template

A Bun + Turborepo monorepo with the product-independent half of a SaaS already working:

| Capability | Where |
| --- | --- |
| Accounts: email/password with OTP verification, Google / GitHub / Apple sign-in, native iOS sign-in, account deletion | `packages/auth`, `apps/web/src/routes/login.tsx` |
| Payments: Stripe Checkout + Customer Portal subscriptions, App Store in-app subscriptions | `packages/auth`, `packages/billing`, `packages/better-auth-app-store` |
| Object storage: Cloudflare R2 (S3 API) for user-uploaded screenshots, with retention clean-up | `packages/api/src/feedback-screenshots.ts`, `apps/server/src/app-client` |
| AI assistant: Mastra agent + CopilotKit AG-UI sidecar, durable runs, private thread history, plan-aware quota | `apps/server/src/mastra`, `apps/web/src/components/copilot` |
| Admin console: users, roles, runtime AI limits, App Store diagnostics, client config, feedback inbox | `apps/web/src/routes/admin`, `packages/api` |
| Analytics: PostHog with regional consent, identity stitching, server-side conversion events | `packages/analytics`, `apps/web/src/lib/analytics*.ts` |
| Ops: Docker images, migration-first startup, health/readiness/metrics, encrypted Postgres backups | `apps/*/Dockerfile`, `docker-compose.yml`, `scripts/` |

## Where your product goes

Platform code reaches product code only through these four locations (enforced by `bun run check:boundaries`):

| Location | Contract |
| --- | --- |
| `packages/product` | `router.ts` composes `appRouter` from `platformRouters` + your tRPC routers; `assistant-contracts.ts` names the assistant agent, its frontend tools and the page-context type; `env.ts` holds product env vars; `src/schema/` holds product tables; `db:post-migrate` runs after migrations |
| `apps/server/src/product/index.ts` | `assistantAgents` (Mastra agents, must include `ASSISTANT_AGENT_ID`) and `serverProduct` (service name, readiness tables, status, metrics, background workers) |
| `apps/web/src/product/index.ts` and `assistant/index.tsx` | navigation, home, admin tabs/settings, SEO and pricing copy, sitemap entries; assistant page context, page tools, tool renderers and welcome card |
| `apps/web/src/routes/**/(product)/` | your pages; put signed-in pages in `routes/_auth/(product)/` and admin pages in `routes/admin/(product)/` so they inherit those guards |

The starter product is deliberately tiny: a home page, an `example.hello` procedure, and an assistant without tools.

## Run it

Requirements: Bun 1.4.4 and Docker.

```bash
cp apps/server/.env.example apps/server/.env   # set BETTER_AUTH_SECRET (openssl rand -base64 32) and an LLM key
cp apps/web/.env.example apps/web/.env
bun install
bun run db:start          # PostgreSQL 18 + Mailpit (sign-up codes at http://localhost:8025)
bun run db:migrate        # platform baseline + your product migrations
bun run doctor            # checks every setting against the real service and says what to do next
bun run dev               # web http://localhost:3001, API http://localhost:3000
```

Stripe, OAuth providers, R2 and PostHog each switch on when their complete variable group is set
([configuration](docs/configuration.md)). App Store in-app purchases stay off (`APP_STORE_ENABLED=false`) until
`packages/env/src/apple-application.ts` describes your iOS app and its credentials are set.

## Deploy it

Dokploy + GitHub Actions, three commands after filling in `.env.dokploy.local` ([deployment](docs/deployment.md)):

```bash
bun run deploy:provision        # Dokploy project, PostgreSQL, migration/API/web apps, domains
bun run deploy:github --apply   # GitHub Actions secrets and variables
bun run deploy:production       # push main; the workflow builds, migrates, deploys and smoke-tests
```

## Stay up to date

`.template.json` and `.template-source` record how and from which commit this repository was exported.
`bun run template:update` in the platform repository re-exports both commits and applies only the platform's
changes here as a three-way merge, so your product code is never overwritten.

## Make it yours

1. Replace the brand: `VITE_BRAND_NAME`, `apps/web/public/brand/*` artwork, and the workspace scope if you want a different one.
   Rewrite the placeholder privacy policy and terms in `apps/web/src/routes/(product)/` (keep `<AnalyticsConsentSettings />` on the privacy page).
2. Add tables in `packages/product/src/schema`, then `bun run db:generate` and commit the reviewed migration (`db:push` is for local experiments only).
3. Add routers in `packages/product/src`, pages in `(product)` route groups, and read-only tools to the assistant in `apps/server/src/product`.
4. Keep `bun run check-types`, `bun run test` and `bun run build` green; CI runs them on every pull request.
5. Product deployment needs (extra variables, a volume, a background worker) go in `packages/product/src/deployment.ts`;
   product smoke checks in `packages/product/smoke/{api,web}.sh`.

`.template-source` records the commit this template was exported from.
