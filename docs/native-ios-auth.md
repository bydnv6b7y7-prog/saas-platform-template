# Native iOS authentication

Updated: 2026-09-13. Better Auth remains pinned to 1.7.2. Historical validation sections retain the configuration used on their recorded dates.

## Invariants

- Better Auth owns identity and server-side sessions. Native iOS uses one long-lived default URLSession and the system HTTPCookieStorage.shared as its sole Cookie store. It never trusts a client-supplied subject as identity or persists Cookie copies in Keychain.
- The same auth instance uses the same account database. Profile/password changes affect the shared account. Self-service account deletion is available server-side via `POST /api/auth/account/delete` (see [account deletion](./account-deletion.md)); a native in-app deletion screen or a deep link to the web `/_auth/account/delete` page satisfies App Store guideline 5.1.1(v).
- The web authorization-code client and callback URLs stay authoritative for web login. Native Google audiences require their configured iOS client ID; native Apple authentication uses the same application catalog identity as billing.
- Apple StoreKit entitlements and Northwind Stripe billing remain separate product entitlements.
- Automated integration tests use an isolated in-memory Better Auth instance without database hooks, Stripe, outbound email or PostHog.

## Protocol

Both Web and native iOS use the default Better Auth Cookie session. URLSession processes Set-Cookie and sends Cookie headers; the native client neither reads set-auth-token nor sends an Authorization header for these endpoints. The Bearer plugin added for the prototype has been removed. Cookie-authenticated native mutations include the auth origin in the Origin header, preserving the existing CSRF checks. The server retains the pinned defaults: a 7-day session lifetime and renewal eligibility after 1 day. The client checks get-session at startup and on foreground, and does not implement a separate access/refresh token pair.

| Operation | Endpoint |
| --- | --- |
| Email registration | `POST /api/auth/sign-up/email` with name, email and password |
| Email login | `POST /api/auth/sign-in/email` |
| Native Apple/Google login | `POST /api/auth/sign-in/social` with provider and idToken |
| Restore session | `GET /api/auth/get-session` |
| Profile | `POST /api/auth/update-user` |
| Logout | `POST /api/auth/sign-out` |
| Delete account | `POST /api/auth/account/delete` with `{ "email": "<account email>" }` |

Email/password sign-in now requires email verification. Signup returns `token: null`
and creates no session. After signup, or a login error with code `EMAIL_NOT_VERIFIED`,
clients call `POST /api/auth/email-otp/send-verification-otp` with `email` and
`type: "email-verification"`. They then submit `email` and the six-digit `otp` to
`POST /api/auth/email-otp/verify-email`. Codes expire after five minutes, allow
three incorrect attempts, and can be resent after 60 seconds. A `503` means
delivery failed; a `429` includes `X-Retry-After` in seconds.

Verification returns `status`, `user`, and a session token, together with
`Set-Cookie` for the submitting client. The native app uses its existing system
Cookie store and confirms the same user via `get-session`; it does not persist
the JSON token. No browser redirect is involved. The `tips` client's account
screen handles pending verification, `.oneTimeCode` input, resend cooldown,
errors and cancellation. See [email verification](./email-verification.md).
Web, API and native adoption must be coordinated before release. Password reset
remains disabled. Account deletion is enabled server-side: the native client
posts the signed-in user's email to `/api/auth/account/delete` (the server
validates it against the session) or links to the web deletion page.

The native client reuses one Alamofire Session with URLSessionConfiguration.default. The system handles Set-Cookie, persistence, expiry and request Cookie matching; there is no custom Cookie snapshot, attribute reconstruction or refresh-token implementation. After login, the app calls get-session with the actual Cookie and verifies the user ID against the login response, so a preexisting Cookie cannot authenticate a different response identity.

Complete authentication operations are serialized across Swift actor suspension points. A superseded response cannot finish after the next auth request changes Cookies; cancelled login cleanup completes before the next operation starts. Logout removes only matching Better Auth cookies, preserving unrelated cookies. Startup/foreground checks coalesce, do not interrupt authentication, preserve profile drafts, and do not proactively clear valid cookies on temporary network failures. UserDefaults stores only a last-login-method display hint, never authentication credentials. The app attempts to delete former Keychain formats without reading or migrating them; the prototype requires one new login.

The standard cookie name is `better-auth.session_token`, with `__Secure-better-auth.session_token` for production HTTPS. Cookie values remain signed server-session identifiers. Browser and native Cookie stores are independent; sharing this protocol does not automatically share a signed-in session between them. Existing Web `createAuthClient` behavior remains valid. Cookies are scoped by host, path and Secure attributes, not by origin/port: use separate hosts for development and production. Tests use isolated in-memory jars; a dedicated UI test uses the simulator app’s real system jar against a loopback HTTP fixture and verifies process-relaunch persistence.

## Native provider configuration

Google: retain `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` for the existing web client. Add `GOOGLE_IOS_CLIENT_ID` from a Google OAuth iOS client registered for `com.example.app`. The app must use that same client ID and its reversed URL scheme. The server accepts both web and iOS audiences; web code exchange still uses the first client.

Apple: configure `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, and `APPLE_PRIVATE_KEY_BASE64`. The native audience derives from [`APPLE_APPLICATION.bundleId`](../packages/env/src/apple-application.ts), currently `com.example.app`, shared with App Store billing. `APPLE_APP_BUNDLE_IDENTIFIER` is no longer required; a remaining legacy value must match the catalog or startup fails. This assertion also applies when billing is disabled. For native-only iOS sign-in, use the App ID `com.example.app` as `APPLE_CLIENT_ID`; a web Services ID is not required. For a shared web/native provider, use the web Services ID as client ID; the host adds the catalog Bundle ID as an audience. Private keys and generated client secrets stay on the server. Native authorization-code exchange/revocation for Apple credentials on account deletion requires an additional reviewed lifecycle flow; the shared deletion endpoint itself is available.

Provider groups remain disabled when absent and reject partial credentials. Merely adding a mobile audience does not enable a provider. A native App ID client does not replace the Services ID and return-URL registration required by a website.

## Existing server effects and privacy

The existing email signup hook records `user_signed_up` with the server user ID when PostHog is configured. The direct native `/sign-in/social` flow is not currently classified by that hook. A native SDK opt-out does not disable server-side analytics. Existing Stripe customer hooks and session IP/user-agent storage still apply to the shared service; the iOS privacy disclosure must include these server behaviors.

The Dokploy provisioner forwards the optional Google native audience only with a complete parent provider group, validates single-line values, and places it in the API environment. Apple identity comes from the shared catalog. The App Store configuration controls and distinct In-App Purchase credentials are documented in [the billing configuration contract](./app-store-subscriptions.md#11-配置发布与运行观察); they do not replace Sign in with Apple credentials. This configuration governance change does not provision or deploy any service.

## Local development

The iOS Simulator can call the Mac service at `http://localhost:3000`; an iPhone's localhost is the phone itself. Release builds require a configured HTTPS auth origin. Do not put the server secret, database URL, or OAuth client secrets in the app.

At inspection, `/api/auth/ok` returned `{"ok":true}` and `/api/auth/providers` returned Google and GitHub. Apple credentials and the Google iOS client were absent. The local database contains existing product data; use the isolated in-memory native-auth test instance for registration tests.

## Validation (2026-09-08)

- `packages/auth`: **31 tests pass**, including email Cookie registration/session lifecycle, signature and tamper rejection, missing/untrusted Origin rejection, default 7-day/1-day renewal policy, renewal/expiry, HTTPS Cookie attributes, rejection of unverified native ID tokens without account/session creation, and additive Google/Apple audiences. The fixture explicitly enables Origin/CSRF checks because Better Auth otherwise skips them in its test environment. `bun run check-types` passes (incremental cache redirected to `/tmp` in the restricted workspace).
- In the preceding integration run, `packages/env` passed 5 tests and type checking, and the provisioner passed `bun build --target=bun --packages=external`. These unchanged configurations were not retested during the Cookie migration; the provisioner was not executed or deployed.
- Native iOS: **34 account/protocol tests** and **2 isolated account UI regressions** pass on iOS 26.5. Protocol tests use real loopback HTTP to exercise system Cookie transport and post-login identity matching; TCA tests cover foreground state transitions. UI tests cover both the mock account flow and system Cookie persistence after app process termination/relaunch, followed by logout and another relaunch. App/Widget Debug and unsigned arm64 Release builds pass with iOS 17.0 deployment targets. Release excludes the Debug mock, HTTP fixture configuration and local StoreKit file. The app privacy disclosure includes account collection and the existing server signup hook, and its in-app copy now describes system session storage.
- The running localhost service health and provider discovery were rechecked read-only. No users were registered in the existing product database, no billing requests were made, and no analytics acceptance events were sent.
- Real Google/Apple authorization, production HTTPS, reset/verification mail delivery, deletion and Apple revocation remain pending their configuration/implementation. Local tests are not production acceptance.

## Review and upgrade boundary

The current review covers the pinned 1.7.2 server, native Cookie client, email/social request boundaries and Web compatibility. CSRF/Origin checks remain enabled; native identity uses the built-in provider signature, issuer, audience, expiry and nonce verification. Apple client secrets are generated on the server, and the app never receives provider client secrets. Mail delivery, the native in-app deletion screen plus Apple token revocation, and real Google/Apple credentials remain release gates; the server-side shared-account deletion endpoint itself is implemented.

The [1.7.3 release](https://github.com/better-auth/better-auth/releases/tag/v1.7.3) restores the earlier account schema. This repository’s Drizzle schema and migration 0009 use the 1.7.2 non-null issuer and issuer/accountId unique index. An upgrade needs coordinated schema cleanup and migration validation; changing only the package version is insufficient. This Cookie refactor changes no server runtime schema or database migration.

References: [Apple Cookie storage](https://developer.apple.com/documentation/foundation/urlsessionconfiguration/httpcookiestorage), [Cookies](https://better-auth.com/docs/concepts/cookies), [Session management](https://better-auth.com/docs/concepts/session-management), [Google](https://better-auth.com/docs/authentication/google), [Apple](https://better-auth.com/docs/authentication/apple).

## Apple sign-in preflight — 2026-09-12

The user confirmed email verification passed and requested native Apple sign-in
acceptance next. The connected iPhone 13 Pro has the app installed. The existing
local device build and its provisioning profile both contain the Sign in with
Apple entitlement for `TEAMID1234.com.example.app`.

The initial localhost/public preflight returned `{"providers":[]}`. The user
subsequently supplied Sign in with Apple Key ID `R6GNJRD95S` and its local `.p8`
path. The key passed a local P-256 signing check. The private IAP environment
initially used `com.example.app` as both App ID client and native audience; no
web Services ID is needed for that native-only flow. Only the API container was recreated
to load the configuration; its image, database and Tunnel were retained. Public
provider discovery now returns `{"providers":["apple"]}`, invalid ID tokens are
rejected with `401 INVALID_TOKEN` without a session Cookie, and the running API
can access Apple's JWKS endpoint. The In-App Purchase SubscriptionKey remains a
separate configuration.

Validation passed: 31 iOS Cookie/protocol tests; 21 backend configuration and
protocol tests with 116 assertions; auth package type checking. The new
`packages/auth/src/apple-native.integration.test.ts` adds ten cases covering
native App ID login without a web Services ID, valid RSA signatures with a native audience and SHA-256 nonce, relay email,
repeat login without a name, linking to an existing verified email account,
session restoration/sign-out, and rejection of a wrong signature, issuer,
audience, expiry or nonce. Only the external JWKS response is substituted with
an ephemeral test public key: Better Auth's real verifier, handler and memory
adapter run unchanged. No real Apple account, mail delivery or billing action
is used by these tests. Evidence is in
`/private/tmp/tips-apple-login-20260912/`; `apple-live-checks.json` records four
public checks after enabling the provider.

The user subsequently confirmed iPhone Apple sign-in passed, recorded as manual
native acceptance. Repeat login and cold-start restoration were not separately
confirmed. Web sign-in is the next acceptance target.

The user supplied the registered web Services ID `com.northwind.dev`, associated
with Primary App ID `TEAMID1234.com.example.app`, domain `iap-dev.northwind.dev`,
and Return URL `https://iap-dev.northwind.dev/api/auth/callback/apple`.
`APPLE_CLIENT_ID` now uses that Services ID, while
`APPLE_APP_BUNDLE_IDENTIFIER=com.example.app` retains the native audience.
The existing API image was retained and its container recreated to load the
private environment. A provider configuration check confirmed web client ID,
native audience and client-secret signing readiness without exposing secrets.

The browser entry and API now share `https://iap-dev.northwind.dev`. Tunnel routes
authentication, tRPC and health endpoints to the API container, and web pages to
the existing Mac Vite service through `host.docker.internal:3001`; other `/api`
and `/internal` paths remain blocked. The ignored `apps/web/.env.local` sets
both `VITE_SERVER_URL` and `VITE_WEB_URL` to this HTTPS origin. Vite explicitly
allows this development hostname. See [Tunnel configuration](../infra/cloudflare/README.md).

The real browser reached Apple's account sign-in page from the website's Apple
button, using the expected Services ID, Return URL and `form_post` response
mode. Five web OAuth-message/API-URL tests passed. Public checks passed for
`/login`, `/api/auth/ok` and Apple provider discovery, while `/internal/metrics`
and `/.env` returned 404. Evidence is in
`/private/tmp/tips-apple-login-20260912/web/public-route-checks.json`.
The user subsequently reported that Apple returns to the website, but the
signed-in state appeared only after several reloads. This report prompted the
first-response fix below; the real Apple flow still needs a repeat check after
the fix.

### Web first-response session rendering

The public shell previously rendered every first response as signed out and
waited for the browser-only session query, treating pending/error states as an
anonymous user. The dev entry also loads Vite modules through the Tunnel.
The live session API returns `Cache-Control: no-store` and is not edge cached.

The root loader now verifies the incoming request Cookie against the existing
API and serializes only the display user (`id`, `name`, `email`). The lookup is
request scoped, bypasses Cookie caching, and uses `disableRefresh=true`; browser
`useSession` keeps ownership of renewal and its `Set-Cookie` response. SSR and
server-function responses remain private/no-store. The initial user bridge
lives in the root, is discarded after the first browser check, and cannot be
reintroduced by a subsequent route change. The header now distinguishes
loading, an API failure with retry, and confirmed anonymous state.

Ten regressions passed, including real Better Auth signed-Cookie reads and
revocation, simultaneous-user isolation, no credential serialization, and
header states. The complete web build/typecheck passed. An isolated HTTP test
against the built web server confirmed a verified account in the very first
HTML with one session read, correct anonymous/revoked responses, no session
token in HTML, and private/no-store response headers. Evidence:
`/private/tmp/tips-apple-login-20260912/web/first-response-check.json` and
`session-build.log`. Its temporary servers and in-memory accounts were stopped.
The local web environment uses `SERVER_URL=http://127.0.0.1:3000` for SSR while
browser requests remain on the HTTPS origin.


### Commit verification — 2026-09-12

The final source passed 57 auth-package tests, eight environment tests and all
119 web tests. The three PostgreSQL OTP concurrency tests also passed in a new,
isolated `email_otp_test` container, which was removed afterward. The auth package
ordinary run skips the database-only suite; the separate database run is the
concurrency evidence. Auth type checking and platform-boundary checks passed.
The complete Web build/typecheck and first-HTML checks described above cover the
same implementation. Logs are in `/private/tmp/tips-commit-20260912/`.

The companion iOS source passed 157 unit tests (148 Swift Testing and nine
XCTest) plus the email-verification UI regression on iOS 26.5. This run excludes
`SubscriptionStoreTests` and does not repeat the complete UI suite. Real email
verification and native Apple sign-in have user confirmation; the real Web Apple
callback still needs a repeat check after the first-response fix.
