# Better Auth App Store plugin

Private workspace integration for StoreKit 2 auto-renewable subscriptions using Apple's official server library. The host owns PostgreSQL DDL, configuration and lifecycle; the package supplies verified state processing, a Drizzle store, Better Auth endpoints and an independent browser client entry.

The implemented contract and rollout checklist are in [the design document](../../docs/app-store-subscriptions.md). The host feature is disabled by default.

- `appStore(options)` registers the plugin and exposes its server-side `service`.
- `./drizzle` exports `createAppStoreDrizzleStore({ db, tables, bundleId, environments })`.
- `./client` exports `appStoreClient()` without Node, Apple SDK or database runtime code.
- `./types` and `./core` provide shared contracts and entitlement evaluation.
- `./certificates/AppleRootCA-G3.cer` is the production trust anchor. Test CAs never enter host configuration.

`service.ready()` validates the installed schema. Start `startAppStoreMaintenance(service)` only after the host starts, and await its `stopAndDrain()` before closing the database pool. Network calls never run inside database transactions.

Run package tests with `bun test src`. The database suite lives at `packages/db/src/iap.integration.test.ts`, uses an explicitly configured `IAP_TEST_DATABASE_URL`, and never falls back to the application database. `scripts/runtime-check.mjs` runs the same certificate and JWS fixtures under Node or Bun; it does not substitute for live Sandbox/OCSP acceptance.
