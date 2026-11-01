# iOS app: Feedback and Ratings

**English** | [简体中文](app-feedback-rating.zh-CN.md)

Status: implemented on both the server and the app · 2026-09-28. The iOS app reads remote settings and submits feedback and screenshots according to the API contract in this file.

## 1. What it does

- **Ratings**: The app shows the system rating prompt (StoreKit `requestReview`) when "the user is actually using the app and has just finished something that went well". Separately, "Me" has a "Rate Northwind" item that opens the App Store write-a-review page. The prompt rules have built-in defaults in the app and can be overridden by values sent from the backend.
- **Feedback**: A native in-app form (message, one optional screenshot, optional contact details; the category is set automatically by the app based on the entry point, and diagnostics are attached automatically and explained on the form). It is submitted to this service, saved, and the operator is notified by email; the admin console can view entries and mark them as handled. The form's on/off switch, categories, character limit, whether screenshots are allowed, and which error screens show an entry point likewise have defaults and can be sent down from the backend.

## 2. Ownership and invariants

| Concept | Single source | Notes |
| --- | --- | --- |
| Client config structure, bounds, defaults | `packages/env/src/app-client-config.ts` (zod) | The API, the Admin form, and the app's built-in defaults all follow it; the app uses the same field names and the same defaults |
| Currently effective config | Single-row `app_client_config` snapshot (with `revision`); the shared defaults when there is no row | Same read order and optimistic locking as `runtime_settings`; every save writes `app_client_config_audit` |
| A feedback entry | An `app_feedback` row; the screenshot object is in R2, its ledger in `app_feedback_screenshot` | The message cannot be changed after creation; only `status` (`new` / `done`) and the handler can change |
| Feedback submitter identity | The Better Auth session on the request (optional) + the app-generated `installationId` | A user ID in the request body is not trusted; `user_id` is null when not signed in |
| Rate limiting | Counted in the database by `installationId` and an IP digest (`sha256(ip + BETTER_AUTH_SECRET)`) | The raw IP is never stored |

- When the app cannot fetch the config, fails to parse it, or sees unknown fields, it always uses the built-in defaults or ignores the unknown fields, and **never disables features or crashes because of config problems**; `review.enabled = false` / `feedback.enabled = false` is the only way to turn things off.
- Feedback returns 201 only after the database commit succeeds; the email notification is sent best-effort after the commit, and a failure is only logged: it does not affect the response, and it is not retried in a way that could send duplicates.
- Screenshots do not pass through this service: the app first requests an upload from this service and gets an R2 presigned PUT URL that is valid for a single object key, restricted to `image/jpeg`, and valid for 10 minutes, then uploads directly to R2; when submitting feedback it sends only the upload ID. Before accepting, the server checks with R2 that the object exists, that its size matches what was registered and is ≤ 1 MB, and that it starts with the JPEG marker. Only admins can view it, through a presigned GET URL valid for 10 minutes. Screenshots are deleted after 180 days (R2 object first, then the ledger row); the feedback message is kept.
- Object keys are `app-feedback/<NODE_ENV>/<yyyy-mm>/<upload-id>.jpg`: when several environments share one bucket they are kept apart by environment and can each have their own lifecycle rules; each environment deletes only the objects in its own ledger.
- Every uploaded object has a ledger row in `app_feedback_screenshot`, and objects in R2 are only ever deleted through the ledger: unclaimed uploads are deleted after 24 hours; after a feedback entry is deleted (for example by an account-deletion cascade), its screenshot is deleted in the next cleanup (hourly).
- When R2 is not configured (any `R2_*` is missing), `allowsScreenshot` sent by `/api/app/config` is always `false` and upload requests return 403; nothing else is affected.
- Diagnostics contain only allowlisted fields (see §3); the server rejects unknown fields and stores no personal information beyond the device identifiers.

## 3. API contract

### `GET /api/app/config` (public)

`Cache-Control: public, max-age=300`. Response:

```json
{
  "revision": 0,
  "review": {
    "enabled": true,
    "minDaysSinceInstall": 7,
    "minActiveDays": 3,
    "requiresWidgetOrActiveDays": true,
    "cooldownDays": 60,
    "oncePerVersion": true,
    "triggers": ["themeApplied", "readingClosed"],
    "delaySeconds": 1
  },
  "feedback": {
    "enabled": true,
    "categories": ["bug", "suggestion", "other"],
    "maxMessageLength": 1000,
    "allowsScreenshot": true,
    "contextualEntries": ["purchaseFailed", "widgetNotUpdating"]
  }
}
```

The values of `triggers`, `categories` and `contextualEntries` come from enums in the contract; the app ignores values it does not recognize.

### `POST /api/app/feedback` (public, may carry a session cookie)

Request body `application/json`, total size limit 1.5 MB:

```json
{
  "installationId": "UUID",
  "category": "bug",
  "message": "1…maxMessageLength characters",
  "contact": "optional, at most 120 characters",
  "context": "optional: purchaseFailed | widgetNotUpdating",
  "diagnostics": {
    "appVersion": "1.4.0", "build": "123", "os": "iOS 27.0", "device": "iPhone18,1",
    "locale": "zh-Hans", "widgetFamilies": ["large"], "pro": false, "theme": "cinnabar"
  },
  "screenshotUploadId": "optional: the uploadId returned by the upload endpoint below, upload completed"
}
```

Every `diagnostics` field may be omitted, but fields outside the allowlist are not accepted. The app currently always sends all allowlisted fields. `category` is chosen by the app based on the entry point: `bug` when entered from an error screen, `other` otherwise; the categories in the admin settings decide which ones the app may use, and when a category is turned off the app falls back to another allowed category.

| Outcome | Status code | Response |
| --- | --- | --- |
| Saved | 201 | `{ "id": "UUID" }` |
| Invalid or too-long fields; screenshot ID does not exist, belongs to another installation, has expired, or has already been used, or the R2 object is missing, has the wrong size, or is not a JPEG | 400 | `{ "error": "invalid_feedback", "field": "…" }` (for screenshot problems the field is `screenshotUploadId`) |
| `feedback.enabled = false` | 403 | `{ "error": "feedback_disabled" }` |
| Rate limit exceeded (per installation 5 per hour, 20 per day; per IP 20 per hour, 100 per day, since company or school networks often share one egress IP) | 429 | `{ "error": "rate_limited" }`, with `Retry-After` |
| Database unavailable | 503 | `{ "error": "unavailable" }` |

### `POST /api/app/feedback/uploads` (public)

Requests one screenshot upload. Request body `{ "installationId": "UUID", "byteLength": 1…1000000 }`.

| Outcome | Status code | Response |
| --- | --- | --- |
| Upload allowed | 201 | `{ "uploadId": "UUID", "method": "PUT", "url": "R2 presigned URL", "headers": { "Content-Type": "image/jpeg", "Content-Length": "…" }, "expiresAt": "ISO time" }` |
| Invalid fields | 400 | `{ "error": "invalid_upload", "field": "…" }` |
| Feedback off, screenshots off, or R2 not configured | 403 | `{ "error": "screenshots_disabled" }` |
| Rate limit exceeded (per installation 10 per hour; per IP 40 per hour) | 429 | `{ "error": "rate_limited" }`, with `Retry-After` |
| Database unavailable | 503 | `{ "error": "unavailable" }` |

The app uploads using the returned `method`, `url` and `headers` as is (the URL is valid for 10 minutes), then submits the feedback within 1 hour. An upload ID can be used only once, and only by the same installation. The signature locks the object key, `Content-Type` and `Content-Length`, and R2 was observed in testing to reject mismatched uploads; within its validity period the URL can PUT the same object repeatedly (same type, same length), and at claim time it is checked once more with HEAD and the file header.

### Admin (tRPC, `adminProcedure`)

- `config.appClient.overview / update({ expectedRevision, values }) / history`: same semantics as `config.operations`.
- `appFeedback.list({ status?, cursor?, limit })` (no screenshot bytes), `appFeedback.detail({ id })` (the screenshot is returned as an R2 presigned GET URL valid for 10 minutes), `appFeedback.setStatus({ id, status })`.
- Admin Web: `/admin/config` gets a new "iOS app" section; new `/admin/feedback` list and detail pages (`?id=` is the link in the notification email).
- When `FEEDBACK_NOTIFY_EMAIL` is set, a summary email is sent after each feedback entry is saved.

## 4. Possible failure modes (identified before implementation)

**Server**
1. When the config table is missing or reading fails, `/api/app/config` returns 500 and the app disables features as a result. → A read failure returns 503, and the app runs on its built-in defaults.
2. Two admins save the config at the same time and the later one overwrites the earlier one. → `expectedRevision` optimistic locking + a transaction lock.
3. The config is written with out-of-bounds values (negative cooldown, 0 character limit). → The shared zod contract validates on both the API and the form.
4. An oversized request body causes memory pressure; the limit is only detected after base64 decoding. → Check `Content-Length` and the raw length first, then decode.
5. Forged `user_id`. → Taken only from the session.
6. Rate limiting stores the raw IP, leaking privacy; or behind a proxy all requests share one IP and get wrongly limited. → Use `x-real-ip` (consistent with the tRPC context), store a digest; also count per installation.
7. Concurrent requests bypass the rate-limit count. → The count and the insert happen in the same transaction, with a transaction-level advisory lock per installation.
8. An email sending failure makes the request fail or causes a duplicate insert. → Send after commit; a failure is only logged.
9. The screenshot is not an image or is a malicious file. → Before accepting, read the first 3 bytes from R2 to check the JPEG header; the upload URL signature locks `Content-Type: image/jpeg`; the admin console displays the presigned URL in an `<img>`.
10. Attachments grow without bound. → 180-day cleanup; cleanup deletes only screenshots.

**Screenshot storage (R2)**
20. A presigned URL leaks or is replayed. → Only for one random object key, PUT only, expires in 10 minutes; the URL contains no credentials; an object is linked to feedback only after this service has checked it.
21. The client requests an upload and then uploads a larger file or a different type. → The signature locks both `Content-Type` and `Content-Length` (whether R2 enforces length is determined by testing, see Acceptance); in any case, before claiming, HEAD checks that the size matches what was registered and is ≤ 1 MB, then the first 3 bytes are read to check for JPEG.
22. Uploads are requested but never submitted, piling up orphan objects in R2. → Each request writes the ledger row before signing; objects unclaimed for more than 24 hours are deleted by cleanup; requests themselves are rate-limited per installation and IP.
23. The same upload ID is claimed by two feedback entries, or used by another installation. → The claim is done inside the submit transaction as an update conditioned on `feedback_id IS NULL`, and requires the same installation.
24. Account deletion removes only database rows and leaves screenshots in R2. → The ledger references feedback with `ON DELETE SET NULL`; objects that were claimed and then lost their feedback are deleted in the next cleanup.
25. R2 is temporarily unavailable. → Requesting an upload does not contact R2 (signing only), so it is unaffected; if the check fails at submit time, 503 is returned and the app keeps the content so the user can retry; objects whose cleanup fails keep their ledger rows and are retried next time.
26. No R2 credentials locally or in CI. → The screenshot feature is turned off entirely and the app is told so through the config; integration tests use an in-memory stand-in, and there is a separate real-R2 test that runs only when credentials are provided.
27. Wrong credentials make every attempt fail without anyone noticing. → `/readyz` reports `objectStorage.configured` (does not affect readiness); the real-R2 test covers signing, upload, checks, reads and deletion.
11. Non-admins read feedback or screenshots. → Everything goes through `adminProcedure`.
12. `/readyz` does not check the new tables, so the service still reports ready when a migration is missed. → The readiness check now includes the four new tables.

Also: when an account is deleted, feedback submitted while signed in is cascade-deleted with the account; feedback submitted while signed out is not tied to any account and is kept.

**App**
13. No config on first launch while offline → use the built-in defaults.
14. The rating prompt appears during onboarding, purchase, while a panel is open, or after an error. → Trigger only at designated moments and when no panel is open; cooldown and version limits are persisted on the device.
15. The system suppresses the prompt, but the device records it as shown. → What is recorded is "requested", and the cooldown is counted from the request time (the system itself also limits it to 3 times a year).
16. A failed feedback submission loses what the user wrote. → The draft is kept and the failure message offers a retry; 429 and 403 get clear copy.
17. Diagnostics include content the user is unaware of or that should not be sent. → Only allowlisted technical information is sent (nothing the reader wrote, viewed or saved), with a one-line note on the form and an item-by-item list on the privacy page. (An earlier per-item checkbox design was confusing and has been removed.)
18. Screenshot too large → The client compresses it to under 1 MB before requesting the upload; when the upload fails or the check does not pass, the form content is kept and the user is told they can remove the screenshot and send.
19. With large text, English, or dark mode, the form gets truncated or buttons cannot be tapped.

## 5. Acceptance (end to end)

- Server: `apps/server/src/app-client/app-client.integration.test.ts`, real PostgreSQL (dedicated database `northwind_app_feedback_test`), sending HTTP requests through the Hono app and calling tRPC as an admin / regular user / signed-out user; storage uses an in-memory stand-in whose behavior matches the R2 behavior verified below (it accepts only the signed type and length). 23 cases cover items 1–12 and 20–26 above: default config and cache headers, admin save and audit, concurrent save conflict, out-of-bounds settings, non-admin rejection, valid submission and notification, notification failure, identity taken only from the session and account-deletion cascade, IP stored only as a digest, the various 400s, settings-driven 400/403, screenshots fully off without R2, direct screenshot upload and single claim, each failed check (not uploaded, wrong size, not JPEG, another installation, over 1 hour) and R2-unavailable 503, two requests racing for the same upload with only one succeeding, upload rate limiting, cleanup (unclaimed after 24 hours, after account deletion, 180 days, failed deletion keeps the ledger row for retry), feedback rate limiting per installation and per IP, concurrent submissions not exceeding the limit, database-unavailable 503, admin pagination and marking. Each run writes all HTTP exchanges to `.tmp/app-feedback/integration-report.json`.

  ```bash
  docker exec northwind-postgres psql -U postgres -c 'CREATE DATABASE northwind_app_feedback_test'   # once
  APP_FEEDBACK_TEST_DATABASE_URL=postgresql://postgres:password@localhost:5432/northwind_app_feedback_test \
    SKIP_ENV_VALIDATION=1 bun test apps/server/src/app-client/app-client.integration.test.ts
  ```

  With the per-installation transaction lock removed, the "concurrent submissions" case fails, which proves the test really covers item 7. CI runs it the same way in `deploy.yml`.
- Real R2: `apps/server/src/app-client/r2-storage.integration.test.ts`, runs only when `APP_FEEDBACK_R2_TEST=1` and `R2_*` are configured (CI has no credentials, so it does not run there); it writes and deletes a few small objects under `app-feedback-test/`: the signature includes `content-length;content-type;host`; PUTs with a mismatched length, mismatched type, or altered path all get 403; expired URLs get 403; an exact upload gets 200; HEAD, reading the file header, and signed GET work; after deletion HEAD is empty and signed GET is 404, and deleting again is harmless. 3 cases passed against `multi-env-storage` on 2026-09-29.

  ```bash
  cd apps/server && APP_FEEDBACK_R2_TEST=1 SKIP_ENV_VALIDATION=1 bun test src/app-client/r2-storage.integration.test.ts
  ```
- Full chain (2026-09-29): on a local server (freshly migrated database, real R2), the app in the simulator submits feedback with a 13.6 MB 3000×4000 image attached → the app compresses it to a 1200×1600, 893,778-byte JPEG → requests an upload → uploads directly to R2 → submits → `app_feedback` and a claimed `app_feedback_screenshot` row → the 10-minute signed URL in the admin detail returns the same 893,778-byte `image/jpeg`.
- `scripts/api-smoke.sh` adds: the public config is readable and has cache headers, invalid feedback and invalid upload requests get 400, the three new admin endpoints get 401 when signed out, `/readyz` reports `objectStorage`.
- App: UI tests use a local HTTP test server to mock the two endpoints and verify the request body the form sends, retry after failure, and that entry points disappear when the config turns them off; ratings are asserted through the analytics event log: "a rating was requested when the conditions were met" and "no more requests after it was turned off".
