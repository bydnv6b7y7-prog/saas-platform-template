# Email verification

**English** | [简体中文](email-verification.zh-CN.md)

Updated: 2026-09-12. Better Auth stays pinned to 1.7.2.

## Contract

| Concern | Source of truth and behavior |
| --- | --- |
| Identity | Better Auth owns `user.emailVerified`. Only an existing unverified account may complete email verification. Verified accounts continue using password or configured social login. |
| Persistence | Signup creates an unverified account and returns `token: null`. Password login creates no session until verification. OTP values are encrypted in the existing `verification` table. No new schema migration is needed. |
| Time | Six numeric digits, five-minute expiry, three incorrect attempts, single use. Resending deletes all older codes. Shared UI constants live in `packages/env/src/email.ts`; the server enforces the policy. |
| Delivery | Cloudflare REST must accept the intended recipient as delivered or queued. Bounce, suppression, malformed responses, HTTP failures and timeouts produce a sanitized `503`. Queue acceptance is not inbox delivery. |
| Session | Successful verification sets the Cookie in the submitting Web/native client. The client confirms the actual session and user before continuing. Existing sessions are not retroactively revoked. |
| Return scope | Web retains a validated internal destination and optional social-link continuation. Return navigation occurs only after its session is confirmed. Emails contain no callback or login URL. |
| Resend | One request per mailbox and per IP per 60 seconds. Mailbox reservations persist in PostgreSQL and apply across replicas and process restarts. IP rate limiting uses Better Auth's existing per-process memory storage; multiple replicas also need a shared IP limiter or an edge rule. |
| Concurrency | A database-backed, 30-second operation lease serializes sending and verification for the same mailbox. Normal completion and API errors release it; expiry recovers an interrupted process. Verification consumption and attempt counts stay under Better Auth. |

The policy applies to new email/password accounts and previously registered users
whose email is unverified. OAuth retains its existing provider identity rules.
Passwords and social login remain the normal login methods after verification.

The Email OTP plugin also contains passwordless login, OTP inspection, password
reset and email-change endpoints. Those routes are disabled. Sending rejects
purposes other than `email-verification`. Unknown and already verified mailboxes
receive the same generic acknowledgment without sending a code or creating a
session. The old link routes `/send-verification-email` and `/verify-email` return
404; this replacement must ship with its updated clients.

## Configure Cloudflare

Configure Email Sending for the sender domain and create an account-scoped token
with `Email Sending: Edit`. Follow the official
[domain setup](https://developers.cloudflare.com/email-service/get-started/send-emails/)
and [REST API documentation](https://developers.cloudflare.com/email-service/api/send-emails/rest-api/).

```dotenv
CLOUDFLARE_ACCOUNT_ID=<32-character account ID>
CLOUDFLARE_EMAIL_API_TOKEN=<account-scoped email sending token>
EMAIL_FROM="Northwind <noreply@northwind.dev>"
```

`EMAIL_FROM` accepts a plain address or `Display Name <address>`. Named senders
use Cloudflare's `{ address, name }` representation. Quote names in dotenv files;
malformed and multiline addresses are rejected.

Local development reads `apps/server/.env`. Production provisioning reads the
group from `.env.dokploy.local` and injects it into the API only. Updating that
local file does not update an existing Dokploy application. Configure all three
values in the production API before release; never expose them through `VITE_`.

Partial configuration fails at initialization. If all three values are absent,
verified accounts and OAuth keep working, while sending returns `503` and
unverified password accounts remain blocked. `/readyz` currently checks core
application dependencies, not email configuration; readiness alone is insufficient
to approve this feature's release.

The transport sends one-recipient text and HTML messages to
`https://api.cloudflare.com/client/v4/accounts/{account_id}/email/sending/send`.
It times out after ten seconds, follows no redirects and does not retry
automatically. Credentials, codes, verification values and provider bodies are
never logged. The OTP route overrides Better Auth 1.7.2's error-catching background
runner for that request so delivery failures propagate to the client.

## Client flow

1. Submit email/password signup or login.
2. After signup returns `token: null`, or login returns `EMAIL_NOT_VERIFIED`, POST
   `/api/auth/email-otp/send-verification-otp` with
   `{ "email": "user@example.com", "type": "email-verification" }`.
3. Show pending, accepted or failed delivery accurately. Sending is triggered by
   the user's action, never by mounting a component or replaying history. Keep the
   account pending after delivery failure and honor `X-Retry-After` on `429`.
4. Submit `{ "email": "user@example.com", "otp": "123456" }` to
   `/api/auth/email-otp/verify-email` from the same client. Codes are strings so
   leading zeros survive. The field supports paste and `one-time-code` autofill;
   native uses `.textContentType(.oneTimeCode)`.
5. On success, consume `Set-Cookie` through the existing Cookie store, then call
   `get-session` to confirm the expected user before entering the app. Do not save
   the JSON session token as a separate credential.
6. Handle `INVALID_OTP`, `OTP_EXPIRED`, `TOO_MANY_ATTEMPTS`, `429` and delivery
   failures with retry actions. Returning to login preserves the email and clears
   the password/code. Codes never enter URLs, analytics, or persistent UI storage.

Web uses the official `emailOTPClient` and the native `tips` client uses the same
REST endpoints through its serialized account transport. The existing Cloudflare
sender is shared. See [Better Auth Email OTP](https://better-auth.com/docs/plugins/email-otp)
and [native Cookie authentication](./native-ios-auth.md).

## Validation and release

Handler tests cover session gating, native Origin and Cookie establishment,
encrypted storage, expiry, attempts, replay, rotation, generic responses, purpose
restrictions, foreign origins, delivery failure and both throttles. Tests against
the dedicated local `email_otp_test` PostgreSQL database exercise concurrent sends,
concurrent verification, attempt budgets and cooldown after auth-instance
recreation. CI and the production workflow run these database tests.

Local validation on 2026-09-12 passed 426 monorepo tests, three dedicated
PostgreSQL concurrency tests, all workspace type checks and production builds.
The iOS simulator passed 40 authentication/store tests. Browser acceptance with
an isolated in-memory API covered signup without a session, six-digit input,
incorrect codes, the real 60-second resend countdown, old-code invalidation,
successful verification, Cookie restoration and the original internal return
destination. A simulated delivery failure preserved the pending account;
returning to sign-in kept the email, cleared the password and restored focus.

The final commit check repeated the auth package (57 passing tests), environment
configuration (eight), Web (119), and all three PostgreSQL concurrency cases in a
new temporary database container, then removed that container. Auth type checking
and platform-boundary checks passed. The ordinary auth run skips the database-only
suite; its cases are covered by the separate PostgreSQL run. The companion iOS
source passed 157 unit tests and the email-verification UI regression; StoreKit
transaction tests and the full UI suite were not part of this run. Logs and the
native result bundle are in `/private/tmp/tips-commit-20260912/`.

Cloudflare domain setup and actual delivery were checked on 2026-09-12. All six
sender DNS records reported ready; the restricted token was active and setup-time
quota was 1,000 emails/day. A real message from `Northwind <noreply@northwind.dev>`
reached Gmail with SPF, DKIM and DMARC passing. A second message confirmed delivery
of the previous link template. These tests did not deploy the applications.

Before production activation, synchronize the API credentials, deploy the API and
updated clients, then use a designated unverified test account to complete signup,
real mail receipt, code verification, session restoration and return navigation.
Include an existing unverified account, code expiry and resend. Local fixtures and
previous transport tests do not replace that live acceptance check.

## IAP Sandbox deployment — 2026-09-12

The native Debug app points to `https://iap-dev.northwind.dev`. Its previous running
container still used the September 11 image: the OTP policy was absent and none
of the three mail settings were injected. Local source and fixture tests had
therefore not changed the native app's actual registration behavior.

The API is now running `e3e346e-email-otp-working-tree`, image
`sha256:4cddaf3040b45f9b14528c8adcf2ebdb1384bdae0e353cee19ea78879d1f9d91`.
The three existing mail settings were copied into the private IAP environment
file and validated in the image and running process. Only the API container was
recreated; its authentication schema and migration journal matched the previous
image, so no database migration was needed. The Sandbox database and Tunnel
continue to be used. The previous image is retained locally as
`northwind-iap-dev-api:pre-email-verification-20260912`.

Before switching, 18 targeted server tests passed, including three PostgreSQL
concurrency tests, and the auth package type check passed. Ten public-endpoint
checks then passed: deployed build, auth health, OTP route validation, send-route
validation, signup without a session, blocked unverified password login, empty
session, foreign-origin rejection on Cookie-bearing requests, existing App Store
authentication, and removal of the temporary acceptance account. Cookie-free
OTP requests still require a valid code; Better Auth's general origin middleware
validates Cookie-bearing requests, so the CSRF probe includes an inert Cookie.
Evidence is in `/private/tmp/tips-email-deploy-20260912/live-checks.json`.

No real verification email was sent during the automated deployment checks.
The user subsequently confirmed on 2026-09-12 that email verification passed;
this is recorded as manual acceptance of the verification flow, separately from
the automated checks above. This deployment does not activate the separate
production environment.
