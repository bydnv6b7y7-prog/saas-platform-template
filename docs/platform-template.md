# Platform template: the boundary between platform capabilities and product code

**English** | [简体中文](platform-template.zh-CN.md)

> Status: Current · 2026-10-31
> Principle: product code lives only in four fixed locations; platform code reaches the product only through entry files. The template is exported from this repository by a script; no hand-maintained copy exists.

## 1. What the platform provides

| Capability | Location |
| --- | --- |
| Accounts: email + password with OTP verification, Google / GitHub / Apple sign-in, native iOS sign-in, account deletion | `packages/auth`, `apps/web/src/routes/login.tsx`, `_auth/` |
| Payments: Stripe Checkout / Portal subscriptions, App Store in-app subscriptions (`better-auth-app-store`) | `packages/auth`, `packages/billing`, `packages/better-auth-app-store` |
| Object storage: Cloudflare R2 (S3 API), with type, size, link lifetime and Free/Pro quota registered per purpose; browser-direct uploads (`storage:cors`), a per-user upload ledger and hourly cleanup ([docs](./object-storage.md)) | `packages/api/src/object-storage.ts`, `user-objects.ts`, `routers/uploads.ts` |
| Agent runtime skeleton: Mastra storage/memory/observability, durable AG-UI runs, thread API, CopilotKit sidebar, per-plan limits | `apps/server/src/mastra`, `apps/web/src/components/copilot` |
| Admin: users and roles, runtime settings, App Store diagnostics, client config, feedback inbox | `packages/api`, `apps/web/src/routes/admin` |
| Analytics: PostHog, region-aware consent, identity stitching, server-side conversion events | `packages/analytics`, `apps/web/src/lib/analytics*.ts` |
| Operations: images, migrate-first startup, `/livez` `/readyz` `/internal/metrics`, encrypted backups | `apps/*/Dockerfile`, `docker-compose.yml`, `scripts/` |

## 2. Where product code lives

| Location | Contents | Entry the platform goes through (contract) |
| --- | --- | --- |
| `packages/product` | Product schema, tRPC routes, product env (`productEnv`), assistant tool contracts, e2e steps (`e2e.ts`) | `router.ts` (composes `appRouter`), `assistant-contracts.ts` (`ASSISTANT_AGENT_ID`, `ASSISTANT_PAGE_TOOL_NAMES`, `AssistantPageContext`); the `db:post-migrate` script |
| `apps/server/src/product` | Ingestion, CLI, workers, tools/skills/instructions for the App Store Agent | `index.ts`: `assistantAgents`, `serverProduct` (service name, readiness tables, status, metrics, background workers) |
| `apps/web/src/product` | Chart/market/Finding components, App SEO, sitemap, assistant page context and tool rendering | `index.ts` (navigation, home page, Admin tabs and settings, footer, SEO, pricing copy, login page copy, sitemap), `assistant/index.tsx` (page context hook, page tools, renderers, welcome card) |
| `apps/web/src/routes/**/(product)/` | Product pages and legal pages (each product has its own privacy policy/terms) | Pages that require sign-in go in `routes/_auth/(product)/`, admin pages in `routes/admin/(product)/`, so they inherit the parent layout's guards |

Dependencies may only point inward:

```text
product (the four places above) ──► platform entry contracts ◄── platform (apps shells, packages/*)
                               └──────────► platform packages (auth/billing/api/db/env/ui …)
```

`bun run check:boundaries` (the first step of `check-types`) enforces this: platform packages must not reference any product code; platform code in `apps/*` may only import
`@northwind/product/{router,assistant-contracts}`, `@/product`, `@/product/assistant` and `apps/server/src/product` (the entry).

Database: platform tables live in `packages/db/src/schema`, product tables in `packages/product/src/schema`, and `drizzle.config.ts` reads both;
this repository's migration history is still a single sequence (`packages/db/src/migrations`). After `db:migrate` in `packages/db` finishes, it calls the product's
`db:post-migrate` (this product uses it to maintain the chart snapshot partitions).

## 3. Exporting the template

```bash
bun scripts/export-template.ts ../my-app --scope @acme --brand Acme --domain acme.com [--config template.json]
bun scripts/export-template.ts --check       # Same as the Template workflow: export to .template-check and run check-types + test
bun scripts/template-update.ts ../my-app     # Bring new platform commits into an exported repository with a three-way merge
```

The export script (`scripts/export-template.ts`):

1. Copies the platform files at that commit, skipping the four product locations above, product docs, `infra/`, the IAP dev tunnel and the export/update scripts themselves;
   the release pipeline (`deploy.yml`, Dokploy provisioning, `deploy:github`, smoke scripts, `.env.dokploy.example`) is exported along with the platform docs;
2. Overlays the product locations with `template/starter/`: home page, `example.hello`, a tool-less assistant, placeholder legal pages, deploy and smoke hooks, template docs and README;
   then layers `template/examples/*/` on top (whole files replaced at the same paths; `--no-examples` skips this). Currently there is only "My notes": user data, browser-direct object storage,
   Free/Pro attachment quotas, assistant read-only tool cards and frontend tools that need confirmation, Admin stats, analytics events and e2e steps;
3. Writes the project identity: scope, brand, domains (Web/API/email/PostHog proxy), `apple-application.ts` (the `apple` block of `--config`;
   defaults to a placeholder App with `APP_STORE_ENABLED=false`); the template's release policy defaults to `REQUIRED_INTEGRATIONS=email`;
4. Gates: the export fails if the result still contains this repository's identity (domains, Bundle ID, App ID, namespace, local paths, etc.), product references in platform code, or dead links;
5. Runs `git init` and `bun install`, generates a baseline migration containing only platform tables plus the hand-written `mastra.ag_ui_*` migration, records `.template.json` and `.template-source`, then commits.

`template/starter/` and `template/examples/` are copies that must change together with the platform contracts; `.github/workflows/template.yml` (this repository only) exports the template both with and without examples,
and fails if either is out of sync with the platform. `template:update` treats older derived repositories that have no recorded `examples` as exported without examples, so it never merges the examples into existing product code.

An exported repository ships with: `bun run doctor` (local) / `doctor --deploy` (before release; makes one request per item against the real services),
`bun run e2e` (production build + PostgreSQL, Mailpit, S3 and a mock model in compose; Playwright runs sign-up → verification code → assistant → product steps (`packages/product/e2e.ts`) →
axe accessibility check (serious/critical fails the run) → screenshots → Admin, and includes Stripe Checkout when `E2E_STRIPE_*` test keys are configured; the mock model can emit
DeepSeek/OpenAI-format `tool_calls` by rule; a separate job in CI), and a three-step launch:
`deploy:provision` → `deploy:github --apply` → `deploy:production` (see the template's `docs/deployment.md`).

`scripts/template-update.ts` uses the derived repository's own answers to export both its source commit and the new commit, and applies the difference with `git apply --3way`:
product code and local changes are kept, and real overlaps become ordinary conflict markers; it does not commit, and it prompts for `db:generate` when the platform schema changed.

### Quality gates

- `bun run check:boundaries`: the platform reaches the product only through entries.
- `bun run test:postgres`: all PostgreSQL integration test groups, each on a freshly created database; CI, the release gate and local runs use the same list.
- `bun run check:unused` (knip): unused files and dependencies fail outright; unused exports and types only warn, because the interfaces and types exported by platform libraries
  are a public API for product code, and in a template with only the starter nothing references them yet.
- The export script only copies files and writes identity (scope, brand, domains, iOS App identity); all product content is supplied by the `template/starter` overlay,
  with no line-by-line rewriting of shared files.

## 4. Known remaining mixing

- `packages/db/scripts/migrate-production.ts` keeps the one-time baseline logic from when this repository moved from `db:push` to a migration sequence; on a new database it is a no-op.
- Internal platform identifiers still carry the `northwind` prefix (Mastra storage id, sidebar DOM id, log fields); this repository keeps them so persisted state is unaffected, and the export replaces them.
- Migration `0020_runtime_settings` only copies `operational_settings(_audit)` and does not delete it; once this release is complete, a follow-up migration drops those two tables.
- Some platform docs exported with the template were written during this product's era, and their examples may still mention pages such as charts (the interface contracts apply).

## 5. Subscription template constraints

- Stripe is the external authority for payments and subscription state; the official Better Auth plugin verifies webhooks and maintains the local projection.
- Entitlements read the local projection; the request path never calls Stripe synchronously, and a success redirect never grants access directly.
- `active` / `trialing` grant access; non-terminal problem states go to the Portal for repair and a second Checkout is blocked;
  only `canceled` / `incomplete_expired` allow creating a new subscription.
- The frontend only reads safe catalog/status DTOs; Price IDs, Customer IDs, Subscription IDs and secrets never leave the server.
- Hosted Checkout and the Customer Portal handle payment details; the app does not store card numbers.

For step-by-step deployment and Stripe Dashboard configuration, see the [subscriptions runbook](./subscriptions.md).
