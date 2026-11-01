# Northwind platform template

**English** | [简体中文](README.zh-CN.md)

A Bun + Turborepo monorepo with the product-independent half of a SaaS already working: accounts, payments, file
uploads, an AI assistant, an admin console, analytics and a one-command release pipeline. You write the product;
the platform stays updatable from upstream.

- [Features](#features)
- [Run it locally](#run-it-locally)
- [What you need to do yourself](#what-you-need-to-do-yourself)
- [Deploy it](#deploy-it)
- [Where your product goes](#where-your-product-goes)
- [Stay up to date](#stay-up-to-date)
- [Documentation](#documentation)

## Features

| Area | What works out of the box | Code |
| --- | --- | --- |
| Accounts | Email + password with a sign-up code by email; Google / GitHub / Apple sign-in; native iOS sign-in; sessions; account deletion | `packages/auth`, `apps/web/src/routes/login.tsx` |
| Email | Sign-up codes through Cloudflare Email Sending; locally every email lands in Mailpit | `packages/auth` |
| Payments | Stripe Checkout and Customer Portal subscriptions (monthly / yearly Pro); App Store in-app subscriptions; one entitlement check for both | `packages/billing`, `packages/better-auth-app-store` |
| File uploads | Cloudflare R2 (any S3 API): the browser uploads straight to the bucket; each upload purpose declares its file types, size limit and Free / Pro quota; files are type-checked by content and cleaned up hourly | `packages/api/src/object-storage.ts`, `user-objects.ts`, `routers/uploads.ts` |
| AI assistant | Mastra agent + CopilotKit: streaming runs that survive reloads, private thread history, tools that render cards, actions that wait for the user's confirmation, per-plan usage limits; DeepSeek, OpenRouter or any OpenAI-compatible model | `apps/server/src/mastra`, `apps/web/src/components/copilot` |
| Admin console | Users and roles, assistant limits (audited), App Store diagnostics and test notifications, iOS app remote settings, feedback inbox, your own product tabs | `apps/web/src/routes/admin`, `packages/api` |
| iOS app support | Remote settings, in-app feedback with screenshots, rating prompts | `apps/server/src/app-client` |
| Analytics | PostHog with consent by region, sign-up / purchase attribution, server-side conversion events | `packages/analytics` |
| Quality gates | Type checks, unit tests, PostgreSQL integration tests, platform/product boundary check, end-to-end browser run with a scripted AI model, accessibility (axe) check | `scripts/`, `test/e2e` |
| Operations | `bun run doctor` checks every setting against the real service; Docker images pinned to the Git SHA; migrations before start; health / readiness / metrics endpoints; encrypted PostgreSQL backups with restore drills | `apps/*/Dockerfile`, `scripts/` |
| Release | Merge to `main` → GitHub Actions verifies, builds images in parallel, migrates, deploys to Dokploy and smoke-tests the live site (about 6 minutes) | `.github/workflows/deploy.yml` |

Each integration (Stripe, OAuth providers, R2, PostHog, App Store) switches on when its full set of variables is set and
stays off when none is. A half-filled set is refused at start, not silently ignored.

### Example: My notes

Unless the template was exported with `--no-examples` (`"examples": false` in `.template.json`), it carries
**My notes**, an example that uses every platform piece at once: per-user data, files uploaded straight to object
storage, the Free / Pro allowance, an assistant tool with a card and a confirm-before-saving action, an Admin page,
analytics and e2e steps. Its guide, `example-notes.md` in the docs folder, explains it and how to remove it.

## Run it locally

Requirements: [Bun](https://bun.sh) 1.4.4 and Docker.

```bash
cp apps/server/.env.example apps/server/.env   # set BETTER_AUTH_SECRET (openssl rand -base64 32)
cp apps/web/.env.example apps/web/.env
bun install
bun run db:start          # PostgreSQL 18 + Mailpit (sign-up codes at http://localhost:8025)
bun run db:migrate        # platform tables, your product's migrations and the assistant's storage
bun run doctor            # checks every setting and says what to do next
bun run dev               # web http://localhost:3001, API http://localhost:3000
```

- Everything except the assistant works without a model key; add `DEEPSEEK_API_KEY` (or another provider, see
  [AI assistant](docs/ai-assistant.md)) to switch it on.
- Ports taken? `POSTGRES_PORT=5440 MAILPIT_PORT=8026 bun run db:start` and update `DATABASE_URL` / `EMAIL_DEV_MAILPIT_URL`;
  for the API set `PORT` (and `BETTER_AUTH_URL`, plus `VITE_SERVER_URL` and `SERVER_URL` in `apps/web/.env`).
  `bun run doctor` reports busy ports; `bun run dev:kill` only stops this checkout's own servers.
- `.env` files are read at start: restart `bun run dev` after editing them.
- Gates: `bun run check-types`, `bun run test`, `bun run test:postgres`, `bun run check:boundaries`, `bun run e2e`.

## What you need to do yourself

Everything below needs an account, a dashboard or a decision only you can make. The code is already in place;
`bun run doctor` (locally) and `bun run doctor --deploy` (production) check each item with a real request and tell you
what is missing.

### Locally

| Step | How | Required |
| --- | --- | --- |
| Generate the auth secret | `openssl rand -base64 32` → `BETTER_AUTH_SECRET` in `apps/server/.env` | Yes |
| Make yourself admin | Sign up, run `bun run admin:lookup you@example.com`, put the id in `ADMIN_USER_IDS`, restart `bun run dev` | For the Admin console |
| Add a model key | `DEEPSEEK_API_KEY` (or OpenRouter / OpenAI-compatible) in `apps/server/.env` | For the assistant |
| Test payments locally | Install the Stripe CLI, set the four `STRIPE_*` test values, run `bun run dev:stripe` | Optional |

### Accounts and services for production

| Service | What to create | Where the values go |
| --- | --- | --- |
| [Dokploy](https://dokploy.com) server | A server with Dokploy installed; an API key (Settings → API/CLI) | `DOKPLOY_URL`, `DOKPLOY_API_KEY` |
| DNS | Two records pointing at that server, e.g. `app.example.com` (web) and `api.example.com` (API); Dokploy issues the certificates | `VITE_WEB_URL`, `VITE_SERVER_URL` |
| GitHub | A repository for this code; `gh auth login` on your machine | — |
| GitHub container registry | A personal access token with `read:packages` and `write:packages` | `DOCKER_REGISTRY_USERNAME`, `DOCKER_REGISTRY_PASSWORD` |
| Cloudflare Email Sending | A sending domain and an account token with Email Sending permission | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_EMAIL_API_TOKEN`, `EMAIL_FROM` |
| AI model | A DeepSeek / OpenRouter / OpenAI-compatible API key | `COPILOT_MODEL_PROVIDER` and its key |

All of these go in `.env.dokploy.local` (copy it from `.env.dokploy.example`). Keep that file safe: the first provisioning
writes the generated `BETTER_AUTH_SECRET` and database password into it.

### Optional integrations

| Integration | What to do in the provider's dashboard | Details |
| --- | --- | --- |
| Stripe subscriptions | Create a Pro product with a monthly and a yearly price; add the webhook `https://<API domain>/api/auth/stripe/webhook` with events `checkout.session.completed` and `customer.subscription.created / updated / deleted`; configure the Customer Portal (invoices, payment method, cancel at period end, switching between the two prices). Do it in both test and live mode | [Subscriptions](docs/subscriptions.md) |
| File uploads (R2) | Create a bucket and an Object Read & Write token limited to it; then `bun run storage:cors --deploy` sets the bucket's CORS rule (if the token may not, it prints the JSON to paste in the bucket's settings) | [Object storage](docs/object-storage.md) |
| Google / GitHub / Apple sign-in | Create an OAuth app; callback `https://<API domain>/api/auth/callback/{google,github,apple}`. Apple web sign-in also needs a Services ID with your domain and that return URL | [Sign-in](docs/native-ios-auth.md) |
| PostHog | Create a project; set its token for the server and the browser; set your reverse-proxy host in `packages/env/src/posthog-hosts.ts` | [Analytics](docs/analytics.md) |
| App Store subscriptions | Describe your app in `packages/env/src/apple-application.ts` (Bundle ID, Apple ID, subscription group, products); create an In-App Purchase key; set the server notification URL `https://<API domain>/api/auth/app-store/notifications` (V2) for Production and Sandbox; send a test notification from Admin → Settings | [App Store](docs/app-store-subscriptions.md) |

To refuse a release while an integration is missing, add it to `REQUIRED_INTEGRATIONS`. `DEPLOY_STAGE=staging` accepts
only Stripe test keys, `production` only live keys.

### After the first release

| Step | How |
| --- | --- |
| First administrator | Sign up on the live site, open `https://<API domain>/api/auth/get-session`, copy `user.id` into `ADMIN_USER_IDS` in `.env.dokploy.local`, run `bun run deploy:provision`, then re-run the latest Deploy workflow. Later admins can be granted the `admin` role in Admin → Users |
| Brand and legal pages | Replace `VITE_BRAND_NAME`, the artwork in `apps/web/public/brand/`, and the placeholder privacy policy and terms in `apps/web/src/routes/(product)/` |
| Search indexing | After the legal pages are final, set the GitHub variable `PRODUCTION_ENABLE_INDEXING` to `true` and release again |
| Backups | In Dokploy, schedule `scripts/backup-postgres.sh` with the backup image (an [age](https://age-encryption.org) public key and an S3 bucket), keep the private key offline, and run `scripts/restore-verify.sh` regularly. See [Deployment](docs/deployment.md#backups-and-restore) |
| Changing server variables | Edit `.env.dokploy.local`, run `bun run deploy:provision`, then redeploy (re-run the workflow or merge a change) |

### Day to day

| Task | How |
| --- | --- |
| Release | Merge a pull request into `main`; the Deploy workflow does the rest |
| Roll back | Re-run Deploy on an older commit, or `git revert` and merge. Migrations only go forward: undo a schema change with a new migration |
| Schema change | Edit `packages/product/src/schema`, `bun run db:generate`, review and commit the migration |
| Platform updates | See [Stay up to date](#stay-up-to-date) |

## Deploy it

Dokploy + GitHub Actions, three commands after filling in `.env.dokploy.local` ([deployment](docs/deployment.md)):

```bash
bun run doctor --deploy         # every line ✓ or – before you go on
bun run deploy:provision        # Dokploy project, PostgreSQL, migration / API / web apps, domains
bun run deploy:github --apply   # GitHub Actions secrets and variables
bun run deploy:production       # push main; the workflow builds, migrates, deploys and smoke-tests
```

A release that changes only source code reuses the cached dependency layer of the images; a change to any
`package.json` or `bun.lock` reinstalls the packages.

## Where your product goes

Platform code reaches product code only through these four locations (enforced by `bun run check:boundaries`):

| Location | Contract |
| --- | --- |
| `packages/product` | `router.ts` composes `appRouter` from `platformRouters` + your tRPC routers; `assistant-contracts.ts` names the assistant agent, its frontend tools and the page-context type; `env.ts` holds product env vars; `src/schema/` holds product tables; `db:post-migrate` runs after migrations; `deployment.ts` declares extra variables, a volume or a background worker; `e2e.ts` adds end-to-end steps |
| `apps/server/src/product/index.ts` | `assistantAgents` (Mastra agents, must include `ASSISTANT_AGENT_ID`) and `serverProduct` (service name, readiness tables, status, metrics, background workers) |
| `apps/web/src/product/index.ts` and `assistant/index.tsx` | navigation, home, admin tabs / settings, SEO and pricing copy, sitemap entries; assistant page context, page tools, tool renderers and welcome card |
| `apps/web/src/routes/**/(product)/` | your pages; put signed-in pages in `routes/_auth/(product)/` and admin pages in `routes/admin/(product)/` so they inherit those guards |

The starter product is deliberately tiny: a home page, an `example.hello` procedure and an assistant without tools.

## Stay up to date

`.template.json` and `.template-source` record how and from which commit this repository was exported.
`bun scripts/template-update.ts <this repository>` in the platform repository re-exports both commits and applies only the
platform's changes here as a three-way merge, so your product code is never overwritten.

## Documentation

Every guide in [`docs/`](docs/README.md) has an English version (`name.md`) and a Chinese one (`name.zh-CN.md`).

| Guide | Covers |
| --- | --- |
| [Deployment](docs/deployment.md) | From an empty server to a live site; backups; rollback |
| [Configuration](docs/configuration.md) | Every variable, optional integrations, admin runtime settings |
| [Platform boundary](docs/platform-template.md) | Where product code goes |
| [Email verification](docs/email-verification.md) | Sign-up codes, Cloudflare Email Sending |
| [Subscriptions](docs/subscriptions.md) | Stripe Checkout / Portal and entitlements |
| [App Store subscriptions](docs/app-store-subscriptions.md) | StoreKit 2: app identity, credentials, server notifications |
| [Sign-in](docs/native-ios-auth.md) | Google / GitHub / Apple, native iOS sign-in |
| [Object storage](docs/object-storage.md) | Upload purposes, quotas, CORS, clean-up |
| [AI assistant](docs/ai-assistant.md) | Agent runtime, limits, memory |
| [Analytics](docs/analytics.md) | PostHog, regional consent, server-side events |
| [Feedback and ratings](docs/app-feedback-rating.md) | iOS remote settings, feedback with screenshots |
| [Account deletion](docs/account-deletion.md) | What is deleted and what is kept |
