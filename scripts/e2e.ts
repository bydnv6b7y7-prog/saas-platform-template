/**
 * End-to-end acceptance of the golden path on production builds, against local stand-ins:
 * PostgreSQL, Mailpit (email), SeaweedFS (S3 / R2) from docker compose, and a mock chat model.
 *
 *   bun run e2e                 # build, migrate a fresh database, start API + web, run the browser flow
 *   bun run e2e --no-build      # reuse the current build
 *
 * Stripe Checkout runs too when E2E_STRIPE_SECRET_KEY, E2E_STRIPE_PRICE_PRO_MONTHLY and
 * E2E_STRIPE_PRICE_PRO_YEARLY hold Test-mode values (the Stripe CLI forwards webhooks).
 * E2E_DATABASE_ADMIN_URL overrides the PostgreSQL superuser URL (default: the compose database).
 * The report is written to .tmp/e2e/report.json; screenshots of failed steps next to it.
 */
import { mkdir, rm } from "node:fs/promises";
import { parseArgs } from "node:util";

import { runGoldenPath, type StepResult } from "../test/e2e/golden-path";
import { startMockLlm } from "../test/e2e/mock-llm";

const { values } = parseArgs({ args: Bun.argv.slice(2), options: { "no-build": { type: "boolean", default: false } } });
const root = new URL("..", import.meta.url).pathname;
const artifacts = `${root}.tmp/e2e`;
const PORT = { api: 3200, web: 3201, llm: 3202 };
const apiUrl = `http://localhost:${PORT.api}`;
const webUrl = `http://localhost:${PORT.web}`;
const mailpitUrl = `http://localhost:${process.env.MAILPIT_PORT ?? 8025}`;
const s3Url = `http://localhost:${process.env.S3_PORT ?? 8333}`;
const s3 = { accessKeyId: "e2e-access-key", secretAccessKey: "e2e-secret-key", bucket: "e2e-feedback", region: "us-east-1" };
const adminUrl = new URL(process.env.E2E_DATABASE_ADMIN_URL
  ?? `postgresql://postgres:${process.env.POSTGRES_PASSWORD ?? "password"}@localhost:${process.env.POSTGRES_PORT ?? 5432}/postgres`);
const databaseName = "e2e_golden_path";
const databaseUrl = Object.assign(new URL(adminUrl.href), { pathname: `/${databaseName}` }).href;
const timings: StepResult[] = [];
const children: Bun.Subprocess[] = [];
let llm: ReturnType<typeof startMockLlm> | null = null;

async function phase(name: string, run: () => Promise<void>) {
  const started = performance.now();
  process.stdout.write(`• ${name}… `);
  await run();
  const ms = Math.round(performance.now() - started);
  timings.push({ step: name, status: "passed", ms });
  console.log(`${(ms / 1000).toFixed(1)} s`);
}

async function waitFor(url: string, seconds = 60) {
  for (let attempt = 0; attempt < seconds; attempt++) {
    const status = await fetch(url).then((response) => response.status).catch(() => 0);
    if (status > 0 && status < 500) return;
    await Bun.sleep(1_000);
  }
  throw new Error(`${url} did not come up within ${seconds} s`);
}

const stripe = Boolean(process.env.E2E_STRIPE_SECRET_KEY && process.env.E2E_STRIPE_PRICE_PRO_MONTHLY && process.env.E2E_STRIPE_PRICE_PRO_YEARLY);
const serverEnv: Record<string, string> = {
  ...(process.env as Record<string, string>),
  NODE_ENV: "development",
  PORT: String(PORT.api),
  DATABASE_URL: databaseUrl,
  BETTER_AUTH_SECRET: `e2e-${crypto.randomUUID()}-${crypto.randomUUID()}`,
  BETTER_AUTH_URL: apiUrl,
  CORS_ORIGIN: webUrl,
  EMAIL_DEV_MAILPIT_URL: mailpitUrl,
  APP_STORE_ENABLED: "false",
  COPILOT_MODEL_PROVIDER: "openai-compatible",
  LLM_API_KEY: "e2e",
  LLM_BASE_URL: `http://127.0.0.1:${PORT.llm}/v1`,
  LLM_MODEL: "e2e-model",
  COPILOTKIT_TELEMETRY_DISABLED: "true",
  R2_ENDPOINT: s3Url,
  R2_BUCKET: s3.bucket,
  R2_ACCESS_KEY_ID: s3.accessKeyId,
  R2_SECRET_ACCESS_KEY: s3.secretAccessKey,
  R2_REGION: s3.region,
  SKIP_ENV_VALIDATION: "",
};

try {
  await rm(artifacts, { recursive: true, force: true });
  await mkdir(artifacts, { recursive: true });

  await phase("start PostgreSQL, Mailpit and S3", async () => {
    await Bun.$`docker compose --profile e2e up -d postgres mailpit s3`.cwd(root).quiet();
    await waitFor(`${mailpitUrl}/api/v1/info`);
    for (let attempt = 0; attempt < 60; attempt++) {
      if ([200, 403].includes(await fetch(`${s3Url}/`).then((response) => response.status).catch(() => 0))) break;
      await Bun.sleep(1_000);
    }
    const { AwsClient } = await import("aws4fetch");
    const client = new AwsClient({ ...s3, service: "s3" });
    const bucket = await client.fetch(`${s3Url}/${s3.bucket}`, { method: "PUT" });
    if (![200, 409].includes(bucket.status)) throw new Error(`could not create bucket (${bucket.status})`);
  });

  await phase("create a fresh database and run migrations", async () => {
    const admin = new Bun.SQL(adminUrl.href);
    for (let attempt = 0; ; attempt++) {
      try {
        await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
        break;
      } catch (error) {
        if (attempt > 30) throw error;
        await Bun.sleep(1_000);
      }
    }
    await admin.unsafe(`CREATE DATABASE ${databaseName}`);
    await admin.close();
    await Bun.$`bun run db:migrate`.cwd(`${root}packages/db`).env(serverEnv).quiet();
    await Bun.$`bun run mastra:migrate`.cwd(`${root}apps/server`).env(serverEnv).quiet();
  });

  if (!values["no-build"]) {
    await phase("production build", async () => {
      await Bun.$`bun run build`.cwd(root).env({
        ...(process.env as Record<string, string>), SKIP_ENV_VALIDATION: "1", VITE_SERVER_URL: apiUrl, VITE_WEB_URL: webUrl,
      }).quiet();
    });
  }

  if (stripe) {
    await phase("forward Stripe test webhooks", async () => {
      const key = process.env.E2E_STRIPE_SECRET_KEY!;
      const secret = (await Bun.$`stripe listen --api-key ${key} --print-secret`.quiet().text()).trim();
      Object.assign(serverEnv, {
        STRIPE_SECRET_KEY: key,
        STRIPE_WEBHOOK_SECRET: secret,
        STRIPE_PRICE_PRO_MONTHLY: process.env.E2E_STRIPE_PRICE_PRO_MONTHLY!,
        STRIPE_PRICE_PRO_YEARLY: process.env.E2E_STRIPE_PRICE_PRO_YEARLY!,
      });
      children.push(Bun.spawn(["stripe", "listen", "--api-key", key, "--forward-to", `${apiUrl}/api/auth/stripe/webhook`], { stdout: "ignore", stderr: Bun.file(`${artifacts}/stripe.log`) }));
    });
  }

  await phase("start the mock model, API and web", async () => {
    llm = startMockLlm(PORT.llm);
    children.push({ kill: () => llm!.stop() } as unknown as Bun.Subprocess);
    children.push(Bun.spawn(["bun", "dist/index.mjs"], { cwd: `${root}apps/server`, env: serverEnv, stdout: Bun.file(`${artifacts}/api.log`), stderr: Bun.file(`${artifacts}/api.err.log`) }));
    children.push(Bun.spawn(["bun", ".output/server/index.mjs"], {
      cwd: `${root}apps/web`,
      env: { ...(process.env as Record<string, string>), NODE_ENV: "production", HOST: "127.0.0.1", PORT: String(PORT.web), SERVER_URL: `http://127.0.0.1:${PORT.api}` },
      stdout: Bun.file(`${artifacts}/web.log`), stderr: Bun.file(`${artifacts}/web.err.log`),
    }));
    await waitFor(`${apiUrl}/readyz`);
    await waitFor(`${webUrl}/version.json`);
    const ready = await fetch(`${apiUrl}/readyz`).then((response) => response.json() as Promise<{ status?: string }>);
    if (ready.status !== "ready") throw new Error(`API is not ready: ${JSON.stringify(ready)}`);
  });

  console.log("• browser golden path");
  const steps = await runGoldenPath({
    webUrl, apiUrl, mailpitUrl, stripe, artifacts,
    modelRequests: () => llm?.completions() ?? 0,
    promoteToAdmin: async (email) => {
      const sql = new Bun.SQL(databaseUrl);
      await sql`UPDATE "user" SET role = 'admin' WHERE email = ${email}`;
      await sql.close();
    },
  });
  for (const result of steps) {
    const mark = result.status === "passed" ? "✓" : result.status === "skipped" ? "–" : "✗";
    console.log(`  ${mark} ${result.step} (${(result.ms / 1000).toFixed(1)} s)${result.detail ? ` — ${result.detail}` : ""}`);
  }
  const report = { finishedAt: new Date().toISOString(), commit: (await Bun.$`git rev-parse HEAD`.cwd(root).quiet().text()).trim(), setup: timings, steps };
  await Bun.write(`${artifacts}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Report: ${artifacts}/report.json`);
  process.exitCode = steps.some((result) => result.status === "failed") ? 1 : 0;
} catch (error) {
  const stderr = (error as { stderr?: Buffer }).stderr?.toString().trim();
  console.error(`\n${(error as Error).message}${stderr ? `\n${stderr.split("\n").slice(-15).join("\n")}` : ""}`);
  console.error(`Logs: ${artifacts}`);
  process.exitCode = 1;
} finally {
  for (const child of children) child.kill();
}
