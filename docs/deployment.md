# Deployment: from an empty server to production

**English** | [简体中文](deployment.zh-CN.md)

Goal: a server with [Dokploy](https://dokploy.com) installed, a GitHub repository, two domains, and three commands to go live.
Every step can be checked with `bun run doctor --deploy`, which makes one real request to each external service and tells you the next step.

## 0. Prerequisites

| Needed | Purpose |
| --- | --- |
| A Dokploy server and API key (Settings → API/CLI) | Runs PostgreSQL, migrations, API, Web |
| Two DNS A records pointing to that server, e.g. `app.example.com`, `api.example.com` | Web and API; Dokploy issues certificates with Let's Encrypt |
| A GitHub repository + `gh auth login` | Actions builds the images and releases in order |
| A GitHub PAT (`read:packages`, `write:packages`) | Pushing and pulling `ghcr.io/<namespace>/*` images |
| A Cloudflare Email Sending sender domain and token | Sign-up verification codes (the only integration required in production) |
| An LLM key (DeepSeek / OpenRouter / OpenAI-compatible) | The assistant; when missing, `/readyz` is not_ready |

Optional: Stripe (card subscriptions), PostHog (analytics), R2 (uploads; once enabled, run `bun run storage:cors --deploy`), Google/GitHub/Apple sign-in, App Store in-app purchases.
Each is enabled by configuring its whole group and disabled by leaving the whole group empty; to refuse a release when one is missing, add it to `REQUIRED_INTEGRATIONS`.

## 1. Fill in `.env.dokploy.local`

```bash
cp .env.dokploy.example .env.dokploy.local
```

Fill it in following the comments in the file. `DEPLOY_STAGE=staging` accepts only Stripe Test keys, and `production` accepts only Live keys.
Leave `BETTER_AUTH_SECRET` and the database password empty; the first provisioning generates them and writes them back to that file. **Keep it safe**: losing it invalidates existing sessions and database connections.

## 2. Provision Dokploy

```bash
bun run deploy:provision
```

Idempotent: creates the project, PostgreSQL, `<project>-migration`, `<project>-server`, `<project>-web` (plus one more when the product declares a worker in
`packages/product/src/deployment.ts`), configures images, environment variables and domains, and writes the
applicationIds back to `.env.dokploy.local`. Re-running only fills in missing configuration; after changing server variables in `.env.dokploy.local`, run it once more.

## 3. Write the GitHub Actions configuration

```bash
bun run deploy:github           # Preview
bun run deploy:github --apply   # Write Secrets and Variables (does not print secrets)
```

## 4. Release

```bash
bun run doctor --deploy   # Continue only when everything is ✓ or –
bun run deploy:production # Check local main, run the gates, push; then follow the workflow
```

`.github/workflows/deploy.yml` on `main`: validate the release contract → type check, tests, build, PostgreSQL integration tests,
migrate an empty database twice, SSR smoke test → build and push images (pinned by Git SHA) → deploy migration → server → web (→ worker) in order,
waiting at each step until the new SHA is live → run `scripts/api-smoke.sh` and `scripts/web-smoke.sh` against the live domains.

## 5. After launch

1. First admin: sign up and sign in on the Web, open `https://<API domain>/api/auth/get-session` in the browser, copy `user.id`,
   put it in `ADMIN_USER_IDS` in `.env.dokploy.local`, re-run `bun run deploy:provision`, then re-run the most recent Deploy in GitHub Actions
   (or push a commit) so the server picks up the new variable. Later admins can be granted the `admin` role directly in Admin → Users.
2. Stripe: in Workbench → Webhooks, add `https://<API domain>/api/auth/stripe/webhook` with the events
   `checkout.session.completed`, `customer.subscription.created|updated|deleted`, and put the signing secret in `STRIPE_WEBHOOK_SECRET`.
3. OAuth: each provider's callback is `https://<API domain>/api/auth/callback/{google|github|apple}`.
4. Indexing: once the legal pages are confirmed, set the GitHub Variable `PRODUCTION_ENABLE_INDEXING` to `true` and release again.

## Backups and restore

`apps/backup/Dockerfile` provides the runtime for scheduled backups and restore drills (`scripts/backup-postgres.sh`, `scripts/restore-verify.sh`):
`pg_dump` is encrypted with [age](https://age-encryption.org) and uploaded to any S3-compatible storage, with daily/weekly retention.

| Variable | Meaning |
| --- | --- |
| `DATABASE_URL` | The database to back up |
| `BACKUP_AGE_RECIPIENT` | age public key; keep the private key offline |
| `BACKUP_S3_BUCKET` / `BACKUP_S3_ENDPOINT` / `BACKUP_S3_PREFIX` | Target bucket, endpoint, prefix |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | Write credentials for that bucket |
| `BACKUP_DAILY_KEEP` / `BACKUP_WEEKLY_KEEP` | Number of copies to keep |
| `BACKUP_AGE_IDENTITY_FILE`, `RESTORE_VERIFY_*` | Restore drill: private key file and temporary database |

In Dokploy, create a scheduled task (Schedules) with this image to run `scripts/backup-postgres.sh`, and regularly run `scripts/restore-verify.sh`
to prove the backups can be restored.

## Rollback

Images are immutable per Git SHA. Rolling back = re-running Deploy in GitHub Actions on an older commit, or `git revert` and then pushing `main`.
Migrations only go forward; a schema change that needs undoing gets a new, reviewed migration.
