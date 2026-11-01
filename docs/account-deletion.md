# Account deletion

Updated: 2026-09-16. Implements App Store guideline 5.1.1(v): an app that
supports account creation must let people delete their account.

## Contract

| | |
| --- | --- |
| Endpoint | `POST /api/auth/account/delete` (Better Auth plugin `account-deletion`, `packages/auth/src/account-deletion.ts`) |
| Body | `{ "email": "<account email>" }` — trimmed/lowercased by the server |
| Auth | Cookie session (`sessionMiddleware`); Better Auth origin/CSRF checks apply |
| Identity confirmation | The typed email must equal the session user's email, or `400 EMAIL_CONFIRMATION_MISMATCH`. The client-side "type your email" dialog is UX, not the security boundary |
| Rate limit | 5 requests / 60 s per client |
| Response | `{ "success": true }` with the session cookie cleared (`Cache-Control: no-store`) |
| Admin parity | `/admin/remove-user` runs the same routine (`createAdminAccess(…, { onDeleteUser })`); stock behavior is preserved when the option is omitted |
| Web UI | `/_auth/account/delete` (account menu → Delete account) — also the deep-link target for the native iOS app |

## Semantics

Deletion is **immediate and hard** — no grace period, no pending state, no
scheduled job. The user-row `DELETE` inside one transaction is the only atomic
commit point. Every external side effect is best-effort, individually wrapped,
and never blocks deletion; failures are logged (`account_deletion.*` events)
and recorded in the returned `DeletedAccountFacts`.

Order of operations in `deleteUserAccount(userId)`:

1. **Capture** the user row and active card subscriptions
   (`subscription.referenceId = userId`, `cancel_at_period_end = false`,
   status `active`/`trialing`/`past_due`).
2. **Stripe**: `subscriptions.update(id, { cancel_at_period_end: true })` per
   active subscription — the current period stays paid, no refund, no renewal.
   Failure proceeds with deletion.
3. **Assistant history** (hook registered by `apps/server/src/mastra/account-cleanup.ts`):
   AG-UI replay projections, Mastra threads/messages/vectors, observational
   memory, plus raw cleanup of `mastra_thread_state` and `mastra_resources`
   rows (not covered by Mastra's `deleteThread`). Missing hook → warn + skip
   (e.g. CLI processes without the server runtime).
4. **PostHog**: person + events deletion via the bulk REST endpoint. Gated on
   `POSTHOG_PERSONAL_API_KEY` + `POSTHOG_PROJECT_ID` (both or neither; partial
   config fails startup). `posthog-node` has no deletion API — the project
   token cannot manage people, a personal API key is required.
5. **Database transaction**: delete `verification` rows for the email (OTP +
   both policy lease identifiers), delete `usage_buckets` by the pseudonymous
   subject hash (`sha256("<BETTER_AUTH_SECRET>:<userId>")` — duplicated
   locally in `account-deletion.ts` because `packages/auth` may not import
   `packages/api`; pinned by a fixed-vector unit test), then `DELETE FROM user`
   — cascades `session`/`account`/market/story rows; sets `user_id` NULL on
   `iap_account`/`iap_subscription`/`beta_invites`. Zero affected rows →
   `USER_NOT_FOUND` (concurrent deletion).
6. **Confirmation email** after commit via the Cloudflare sender, stating what
   was deleted and the subscription behavior below.

## Deleted vs retained

| Deleted (cascade or explicit) | Retained by design |
| --- | --- |
| `user`, `session`, `account` | `subscription` (Stripe ledger; webhooks are authoritative) |
| `verification` rows for the email | `iap_account` / `iap_subscription` rows — anonymized tombstones; `claimed_at` preserved (ownership rule) |
| `semantic_queries`, `finding_interactions`, `saved_validations`, `share_links`, `change_story_feedback` | `iap_ownership_audit`, `iap_admin_action`, `rule_overrides`, `runtime_settings_audit`, `app_client_config_audit` (plain-text actor IDs) |
| `usage_buckets` rows for the user's hash | `beta_invites` history (FKs set NULL) |
| Mastra threads/messages/state/working memory | |
| `app_feedback` sent while signed in; its R2 screenshot at the next hourly clean-up | `app_feedback` sent while signed out — never linked to an account ([app feedback](./app-feedback-rating.md)) |
| PostHog person + events (when configured) | |

## Subscriptions on deletion

- **Card (Stripe)**: cancelled at period end automatically. The retained
  ledger row keeps webhook processing working after the user row is gone;
  verify with `stripe listen` + `dev:stripe` after deleting a test account.
- **Apple IAP**: cannot be cancelled server-side. The deletion page and the
  confirmation email both tell the user to cancel in
 App Store → Subscriptions.

## Tests

- Unit: `packages/auth/src/account-deletion.test.ts` (verification identifier
  set, usage-hash fixed vectors, PostHog request shape).
- Integration (dedicated database only):
  `ACCOUNT_DELETION_TEST_DATABASE_URL=postgres://…127.0.0.1/northwind_account_deletion_test bun test packages/auth/src/account-deletion.postgres.test.ts`
- Web: `apps/web/src/lib/account.test.ts` (request shape + error mapping).

## Native iOS integration

Post the signed-in user's email with the shared cookie jar, or deep-link to
`https://<web-origin>/account/delete`. Apple authorization-code token
revocation stays a separate reviewed flow (see
[native iOS auth](./native-ios-auth.md)).
