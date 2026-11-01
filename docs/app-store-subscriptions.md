# App Store in-app purchases (StoreKit 2)

**English** | [简体中文](app-store-subscriptions.zh-CN.md)

iOS in-app subscriptions and website Stripe subscriptions share one set of accounts and entitlement checks, implemented by the `packages/better-auth-app-store`
plugin: after a purchase, the App hands the signed transaction to the server, which verifies the signature with Apple's official library, binds it to the account, maintains a local subscription projection,
and handles App Store Server Notifications V2. The plugin's interface contract is in `packages/better-auth-app-store/README.md`.

## 1. Tell the platform who your App is

Edit `packages/env/src/apple-application.ts`:

| Field | Source |
| --- | --- |
| `bundleId` | The App's Bundle ID in Xcode / App Store Connect |
| `appAppleId` | App Store Connect → App Information → Apple ID (numeric) |
| `subscriptionGroupId` | Subscription group ID (not the Apple ID of a single subscription) |
| `products` | Each subscription product's Product ID, display name and the entitlement it grants (e.g. `pro`) |

These are public identity values and ship with the code; sign-in (the audience for native Apple sign-in) and in-app purchases share them.

## 2. Credentials (deployment environment only)

In App Store Connect → Users and Access → Integrations → In-App Purchase, create an **In-App Purchase** key (do not reuse the Sign in with Apple key):

```bash
APP_STORE_ISSUER_ID=…
APP_STORE_KEY_ID=…
APP_STORE_PRIVATE_KEY_BASE64=$(base64 < SubscriptionKey_XXXX.p8 | tr -d '\n')
APP_STORE_ENVIRONMENTS=Sandbox          # Change to Production after launch (Production,Sandbox receives both)
APP_STORE_ENABLED=true
```

If any of these is missing while `APP_STORE_ENABLED=true`, the API refuses to start; without an App, keep `APP_STORE_ENABLED=false`.
`bun run doctor` checks that this group is complete.

## 3. Server notifications

In App Store Connect → App Information → App Store Server Notifications, fill in both Production and Sandbox with:

```
https://<API domain>/api/auth/app-store/notifications
```

Choose version V2. After saving, go to **Admin → Settings → App Store subscriptions** and use "Send test notification" under Test notification to request one test notification; once it shows up below, the connection works.
The panel also shows whether the credentials are present, the backlog per environment and the latest processing results (it does not show key contents).

## 4. Acceptance order

1. Sandbox: buy with a Sandbox Apple account in TestFlight / a development build, confirm the binding and notification appear in Admin, and that the website-side entitlement syncs to Pro;
2. Go through a renewal, a cancellation and a refund once each, and confirm the projection state changes with the notifications;
3. Switch to `APP_STORE_ENVIRONMENTS=Production` and send another test notification before submitting for review.

Background jobs re-verify active subscriptions every `APP_STORE_REVERIFY_INTERVAL_SECONDS` (default 900) and backfill notification history every
`APP_STORE_RECONCILE_INTERVAL_SECONDS` (default 21600); these usually do not need changing.
