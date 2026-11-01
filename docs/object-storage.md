# Object storage: one bucket, registered by purpose

**English** | [简体中文](object-storage.zh-CN.md)

All uploads share one S3-compatible bucket (Cloudflare R2 in production, SeaweedFS from compose locally), enabled as a group by the four `R2_*` variables.
Clients upload directly to the bucket with a signed URL; the service only signs, verifies, presents and deletes, and never handles file contents.

## 1. Purposes (`StoragePurpose`)

Each kind of upload is registered once, stating what it may be:

| Field | Meaning |
| --- | --- |
| `name` | The first segment of the key: `<name>/<env>/<yyyy-mm>/<id>.<ext>`, making it easy to apply lifecycle rules or cleanup per purpose |
| `types` | Allowed MIME types, each with its file-header magic bytes (`IMAGE_TYPES` provides JPEG / PNG / PDF) |
| `maxBytes` | Per-file size limit |
| `uploadSeconds` / `viewSeconds` | Lifetime of the upload URL and the view URL |
| `quota` (user uploads only) | Number of files and total bytes that Free / Pro may each keep at once |

The signature covers `Content-Type` and `Content-Length`: the upload must match what was requested, or storage returns 403 outright. After upload, the service uses `HEAD` and the first few bytes to verify size, type and file header; the upload only counts once verification passes.

## 2. Two ledgers

| Ledger | Owner | Used for |
| --- | --- | --- |
| `app_feedback_screenshot` | iOS App install (anonymous) | App feedback screenshots, rate-limited per install and IP; see [Feedback and rating](./app-feedback-rating.md) |
| `stored_object` | Signed-in user | Attachments, avatars and the like in the product, `packages/api/src/user-objects.ts` |

Both **write the row first, then sign**: every object that might exist in the bucket has a row responsible for deleting it.

Lifecycle of a user upload:

1. `reserve`: check type, size, and the user's quota for that purpose (locked per user, so concurrency cannot exceed it), write the row, return a signed PUT;
2. The browser uploads directly to the bucket;
3. `confirm`: verify the bytes and mark it confirmed; the product links this id to its own row;
4. `viewUrl`: only for the owner and only for confirmed objects, returns a short-lived signed GET;
5. `release`: called by the product in the same transaction when it deletes the linked row;
6. Hourly cleanup: deletes objects and rows that were released, whose account was deleted (`user_id` set to null by the foreign key), or that were not confirmed within an hour. Rows whose deletion fails are kept until the next run.

Integrating a product takes three steps: define a `UserStoragePurpose`; mount `createUploadRouter(purpose)` on the product router; call `userObjects.release(ids, transaction)` when deleting the linked row.

## 3. Browser-direct uploads need CORS

```bash
bun run storage:cors            # Local: R2_* and CORS_ORIGIN from apps/server/.env
bun run storage:cors --deploy   # Production: R2_* and VITE_WEB_URL from .env.dokploy.local
```

The rule only allows `PUT` / `GET` / `HEAD` and the `content-type` header from the Web domain. An R2 token with only object read/write permission cannot change bucket settings;
in that case the script prints JSON, which you paste into Cloudflare → R2 → bucket → Settings → CORS policy.

`bun run doctor [--deploy]` verifies this by sending a real preflight request from the Web domain; `bun run e2e` writes the same rules to the local S3 stand-in.

## 4. Credentials

The token only needs object read/write permission on that bucket. `/readyz` reports `objectStorage.configured` (it does not affect readiness); without a bucket, the upload entry points are closed and everything else works as usual.
