/**
 * Checks that this checkout can run (and, with --deploy, release) end to end, and says what to do next.
 * Every integration is checked against the real service, never only for presence. Secret values are
 * never printed.
 *
 *   bun run doctor            # local development: tools, apps/{server,web}/.env, database, integrations
 *   bun run doctor --deploy   # production release: .env.dokploy.local, Dokploy, DNS, GHCR, GitHub
 */
import dotenv from "dotenv";
import { resolve4 } from "node:dns/promises";
import { existsSync, readFileSync } from "node:fs";

import { parseDeployPolicy } from "./deploy-config";

export type Status = "ok" | "warn" | "fail" | "off";
export type Check = { section: string; name: string; status: Status; detail: string; next?: string };

const root = new URL("..", import.meta.url).pathname;
const read = (path: string) => (existsSync(root + path) ? dotenv.parse(readFileSync(root + path, "utf8")) : null);
const timeout = () => AbortSignal.timeout(10_000);

/** Which keys of an all-or-none group are set: "off" when none, "partial" when some, "on" when all. */
export function groupState(env: Record<string, string | undefined>, keys: readonly string[]): { state: "off" | "partial" | "on"; missing: string[] } {
  const missing = keys.filter((key) => !env[key]?.trim());
  return { state: missing.length === keys.length ? "off" : missing.length ? "partial" : "on", missing };
}

export function exitCode(checks: Check[]): number {
  return checks.some((check) => check.status === "fail") ? 1 : 0;
}

export function render(checks: Check[]): string {
  const icon: Record<Status, string> = { ok: "✓", warn: "!", fail: "✗", off: "–" };
  const lines: string[] = [];
  let section = "";
  for (const check of checks) {
    if (check.section !== section) {
      section = check.section;
      lines.push("", section);
    }
    lines.push(`  ${icon[check.status]} ${check.name}: ${check.detail}`);
    if (check.next && check.status !== "ok") lines.push(`      → ${check.next}`);
  }
  const failed = checks.filter((check) => check.status === "fail").length;
  const warned = checks.filter((check) => check.status === "warn").length;
  lines.push("", failed ? `${failed} problem(s) must be fixed, ${warned} warning(s).` : `Ready (${warned} warning(s)).`);
  return lines.join("\n");
}

async function http(url: string, init: RequestInit = {}): Promise<{ status: number; json: any }> {
  try {
    const response = await fetch(url, { ...init, signal: timeout(), redirect: "error" });
    const text = await response.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, json };
  } catch {
    return { status: 0, json: null };
  }
}

async function emailChecks(env: Record<string, string | undefined>, section: string, production: boolean): Promise<Check[]> {
  if (!production && env.EMAIL_DEV_MAILPIT_URL) {
    const inbox = await http(`${env.EMAIL_DEV_MAILPIT_URL.replace(/\/+$/, "")}/api/v1/info`);
    return [inbox.status === 200
      ? { section, name: "Email", status: "ok", detail: `development inbox at ${env.EMAIL_DEV_MAILPIT_URL}` }
      : { section, name: "Email", status: "fail", detail: "Mailpit is not reachable", next: "bun run db:start (starts PostgreSQL and Mailpit)" }];
  }
  const group = groupState(env, ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_EMAIL_API_TOKEN", "EMAIL_FROM"]);
  if (group.state === "off") {
    return [{ section, name: "Email", status: "fail", detail: "no sender: sign-up verification codes cannot be delivered",
      next: production ? "set CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_EMAIL_API_TOKEN and EMAIL_FROM" : "set EMAIL_DEV_MAILPIT_URL=http://localhost:8025 (or the Cloudflare group)" }];
  }
  if (group.state === "partial") return [{ section, name: "Email", status: "fail", detail: `missing ${group.missing.join(", ")}` }];
  const headers = { Authorization: `Bearer ${env.CLOUDFLARE_EMAIL_API_TOKEN}` };
  const account = await http(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/tokens/verify`, { headers });
  const user = account.json?.success ? account : await http("https://api.cloudflare.com/client/v4/user/tokens/verify", { headers });
  return [user.json?.success
    ? { section, name: "Email", status: "ok", detail: `Cloudflare token is active; sender ${env.EMAIL_FROM}` }
    : { section, name: "Email", status: "fail", detail: "Cloudflare rejected the email token", next: "create a token with Email Sending: Edit for this account" }];
}

async function stripeChecks(env: Record<string, string | undefined>, section: string, expectedMode: "live" | "test" | null, apiUrl: string | undefined, required: boolean): Promise<Check[]> {
  const keys = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_PRO_MONTHLY", "STRIPE_PRICE_PRO_YEARLY"] as const;
  const group = groupState(env, keys);
  if (group.state === "off") {
    return [{ section, name: "Stripe", status: required ? "fail" : "off", detail: "not configured: card subscriptions are hidden", next: "set the four STRIPE_* values (docs/subscriptions.md)" }];
  }
  if (group.state === "partial") return [{ section, name: "Stripe", status: "fail", detail: `missing ${group.missing.join(", ")}` }];
  const secret = env.STRIPE_SECRET_KEY!.trim();
  const mode = /^(?:sk|rk)_live_/.test(secret) ? "live" : /^(?:(?:sk|rk)_test_|rkcs_test_)/.test(secret) ? "test" : null;
  const checks: Check[] = [];
  if (!mode) return [{ section, name: "Stripe", status: "fail", detail: "STRIPE_SECRET_KEY is not a Stripe secret or restricted key" }];
  if (expectedMode && mode !== expectedMode) {
    checks.push({ section, name: "Stripe mode", status: "fail", detail: `${mode} key, but this stage needs ${expectedMode}`, next: "DEPLOY_STAGE=production uses Live keys; staging uses Test keys" });
  } else {
    checks.push({ section, name: "Stripe mode", status: "ok", detail: `${mode} mode` });
  }
  const auth = { Authorization: `Bearer ${secret}` };
  for (const key of ["STRIPE_PRICE_PRO_MONTHLY", "STRIPE_PRICE_PRO_YEARLY"] as const) {
    const price = await http(`https://api.stripe.com/v1/prices/${encodeURIComponent(env[key]!.trim())}`, { headers: auth });
    checks.push(price.status === 200
      ? { section, name: key, status: price.json?.active && price.json?.recurring ? "ok" : "fail", detail: price.json?.active ? `${price.json.recurring?.interval ?? "one-time"} price, ${price.json.currency}` : "price is archived" }
      : price.status === 403
        ? { section, name: key, status: "warn", detail: "the restricted key cannot read prices; not verified" }
        : { section, name: key, status: "fail", detail: `Stripe returned ${price.status || "no response"} for this price ID`, next: "use a Price ID from the same Stripe mode as the key" });
  }
  if (!env.STRIPE_WEBHOOK_SECRET!.startsWith("whsec_")) {
    checks.push({ section, name: "Stripe webhook", status: "fail", detail: "STRIPE_WEBHOOK_SECRET must be an endpoint signing secret (whsec_…)" });
  } else if (apiUrl?.startsWith("https://")) {
    const url = `${apiUrl.replace(/\/+$/, "")}/api/auth/stripe/webhook`;
    const endpoints = await http("https://api.stripe.com/v1/webhook_endpoints?limit=100", { headers: auth });
    const found = endpoints.json?.data?.find((endpoint: { url: string; status: string }) => endpoint.url === url);
    checks.push(endpoints.status === 200
      ? found
        ? { section, name: "Stripe webhook", status: found.status === "enabled" ? "ok" : "fail", detail: `${url} is ${found.status}` }
        : { section, name: "Stripe webhook", status: "fail", detail: `no endpoint for ${url}`, next: "add it in Stripe Workbench → Webhooks (checkout.session.completed, customer.subscription.*) and copy its signing secret" }
      : { section, name: "Stripe webhook", status: "warn", detail: "the key cannot list webhook endpoints; confirm the endpoint manually" });
  } else {
    checks.push({ section, name: "Stripe webhook", status: "ok", detail: "local: forward events with bun run dev:stripe and use the whsec it prints" });
  }
  return checks;
}

async function storageChecks(env: Record<string, string | undefined>, section: string): Promise<Check[]> {
  const group = groupState(env, ["R2_ENDPOINT", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]);
  if (group.state === "off") return [{ section, name: "Object storage (R2)", status: "off", detail: "not configured: feedback screenshots are off" }];
  if (group.state === "partial") return [{ section, name: "Object storage (R2)", status: "fail", detail: `missing ${group.missing.join(", ")}` }];
  const client = new Bun.S3Client({
    endpoint: env.R2_ENDPOINT, bucket: env.R2_BUCKET, accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    region: env.R2_REGION || "auto",
  });
  const key = `doctor/${crypto.randomUUID()}.txt`;
  try {
    await client.write(key, "doctor");
    const back = await client.file(key).text();
    await client.delete(key);
    return [{ section, name: "Object storage (R2)", status: back === "doctor" ? "ok" : "fail", detail: `wrote, read and deleted a probe object in ${env.R2_BUCKET}` }];
  } catch {
    return [{ section, name: "Object storage (R2)", status: "fail", detail: `could not write to bucket ${env.R2_BUCKET}`, next: "check the endpoint, bucket name and that the token may write objects" }];
  }
}

async function modelChecks(env: Record<string, string | undefined>, section: string, required = true): Promise<Check[]> {
  const provider = env.COPILOT_MODEL_PROVIDER?.trim() || "openai-compatible";
  const key = provider === "deepseek" ? env.DEEPSEEK_API_KEY : provider === "openrouter" ? env.OPENROUTER_API_KEY : env.LLM_API_KEY;
  if (!key?.trim()) {
    return [{ section, name: "AI assistant", status: required ? "fail" : "warn", detail: `${provider} has no API key: everything else works, the assistant says it is not set up and /readyz stays not_ready`,
      next: provider === "deepseek" ? "set DEEPSEEK_API_KEY" : provider === "openrouter" ? "set OPENROUTER_API_KEY" : "set LLM_API_KEY (and LLM_BASE_URL + LLM_MODEL for another host)" }];
  }
  const url = provider === "deepseek" ? "https://api.deepseek.com/models"
    : provider === "openrouter" ? "https://openrouter.ai/api/v1/key"
    : `${(env.LLM_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/+$/, "")}/models`;
  const response = await http(url, { headers: { Authorization: `Bearer ${key.trim()}` } });
  return [response.status === 200
    ? { section, name: "AI assistant", status: "ok", detail: `${provider} accepted the key` }
    : { section, name: "AI assistant", status: "fail", detail: `${provider} returned ${response.status || "no response"} for the key`, next: "check the key and base URL" }];
}

function configurationChecks(env: Record<string, string | undefined>, section: string, apiUrl: string): Check[] {
  const checks: Check[] = [];
  for (const [name, keys] of [
    ["Google sign-in", ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]],
    ["GitHub sign-in", ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"]],
    ["Apple sign-in", ["APPLE_CLIENT_ID", "APPLE_TEAM_ID", "APPLE_KEY_ID", "APPLE_PRIVATE_KEY_BASE64"]],
  ] as const) {
    const group = groupState(env, keys);
    const provider = name.split(" ")[0]!.toLowerCase();
    checks.push(group.state === "on"
      ? { section, name, status: "ok", detail: `register callback ${apiUrl.replace(/\/+$/, "")}/api/auth/callback/${provider}` }
      : group.state === "partial"
        ? { section, name, status: "fail", detail: `missing ${group.missing.join(", ")}` }
        : { section, name, status: "off", detail: "button hidden" });
  }
  const appStoreEnabled = (env.APP_STORE_ENABLED ?? "true").trim() !== "false";
  const appStore = groupState(env, ["APP_STORE_ISSUER_ID", "APP_STORE_KEY_ID", "APP_STORE_PRIVATE_KEY_BASE64"]);
  checks.push(!appStoreEnabled
    ? { section, name: "App Store billing", status: "off", detail: "APP_STORE_ENABLED=false" }
    : appStore.state === "on"
      ? { section, name: "App Store billing", status: "ok", detail: "credentials present (identity: packages/env/src/apple-application.ts)" }
      : { section, name: "App Store billing", status: "fail", detail: "enabled without App Store Connect credentials: the API refuses to start", next: "set APP_STORE_ENABLED=false until you have them" });
  const token = env.POSTHOG_PROJECT_TOKEN?.trim();
  checks.push(!token
    ? { section, name: "Analytics (PostHog)", status: "off", detail: "no project token" }
    : /^phc_[A-Za-z0-9_-]{20,}$/.test(token)
      ? { section, name: "Analytics (PostHog)", status: "ok", detail: "project token format is valid" }
      : { section, name: "Analytics (PostHog)", status: "fail", detail: "POSTHOG_PROJECT_TOKEN is not a project token (phc_…)" });
  checks.push(env.ADMIN_USER_IDS?.trim()
    ? { section, name: "Admin access", status: "ok", detail: `${env.ADMIN_USER_IDS.split(",").filter(Boolean).length} bootstrap administrator(s)` }
    : { section, name: "Admin access", status: "warn", detail: "no administrator yet", next: "sign up, then bun run admin:lookup you@example.com, put the id in ADMIN_USER_IDS and restart bun run dev (.env is read at start)" });
  const secret = env.BETTER_AUTH_SECRET?.trim() ?? "";
  checks.push(secret.length >= 32 && !/replace-with/.test(secret)
    ? { section, name: "BETTER_AUTH_SECRET", status: "ok", detail: "set" }
    : { section, name: "BETTER_AUTH_SECRET", status: "fail", detail: "missing or still the example value", next: "openssl rand -base64 32" });
  return checks;
}

async function localChecks(): Promise<Check[]> {
  const checks: Check[] = [];
  const section = "Tools";
  const pinned = JSON.parse(await Bun.file(root + "package.json").text()).packageManager?.replace("bun@", "");
  checks.push(Bun.version === pinned
    ? { section, name: "Bun", status: "ok", detail: Bun.version }
    : { section, name: "Bun", status: "warn", detail: `${Bun.version}, repository pins ${pinned}`, next: "bun upgrade" });
  const docker = Bun.spawnSync(["docker", "info", "--format", "{{.ServerVersion}}"], { stdout: "pipe", stderr: "pipe" });
  checks.push(docker.exitCode === 0
    ? { section, name: "Docker", status: "ok", detail: docker.stdout.toString().trim() }
    : { section, name: "Docker", status: "fail", detail: "not running", next: "start Docker Desktop (PostgreSQL and Mailpit run in containers)" });

  const server = read("apps/server/.env");
  const web = read("apps/web/.env");
  for (const [path, value] of [["apps/server/.env", server], ["apps/web/.env", web]] as const) {
    checks.push(value
      ? { section: "Configuration files", name: path, status: "ok", detail: "present" }
      : { section: "Configuration files", name: path, status: "fail", detail: "missing", next: `cp ${path}.example ${path}` });
  }
  if (!server) return checks;

  const db = "Database";
  try {
    const sql = new Bun.SQL(server.DATABASE_URL!);
    const [{ applied }] = await sql`SELECT count(*)::int AS applied FROM drizzle.__drizzle_migrations`.catch(() => [{ applied: 0 }]);
    const journal = JSON.parse(await Bun.file(root + "packages/db/src/migrations/meta/_journal.json").text()).entries.length;
    const [{ mastra }] = await sql`SELECT to_regclass('mastra.mastra_ai_spans') IS NOT NULL AS mastra`;
    await sql.close();
    if (!mastra) checks.push({ section: db, name: "Assistant storage", status: "fail", detail: "the mastra schema is missing", next: "bun run db:migrate (it also runs the assistant storage migration)" });
    checks.push(applied >= journal
      ? { section: db, name: "PostgreSQL", status: "ok", detail: `${applied}/${journal} migrations applied` }
      : { section: db, name: "PostgreSQL", status: "fail", detail: `${applied}/${journal} migrations applied`, next: "bun run db:migrate" });
  } catch {
    checks.push({ section: db, name: "PostgreSQL", status: "fail", detail: "cannot connect with DATABASE_URL", next: "bun run db:start" });
  }

  for (const [name, port, key] of [["API", Number(server.PORT) || 3000, "PORT in apps/server/.env (then BETTER_AUTH_URL, and VITE_SERVER_URL + SERVER_URL in apps/web/.env)"], ["Web", 3001, "the web dev port is fixed at 3001"]] as const) {
    const busy = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } }).then((socket) => { socket.end(); return true; }, () => false);
    checks.push(busy
      ? { section: "Ports", name: `${name} ${port}`, status: "warn", detail: "already in use (fine if it is this app's dev server)", next: `stop the other program, or change ${key}` }
      : { section: "Ports", name: `${name} ${port}`, status: "ok", detail: "free" });
  }

  const section2 = "Integrations";
  checks.push(...await emailChecks(server, section2, false));
  checks.push(...await stripeChecks(server, section2, null, undefined, false));
  checks.push(...await storageChecks(server, section2));
  checks.push(...await modelChecks(server, section2, false));
  checks.push(...configurationChecks(server, section2, server.BETTER_AUTH_URL || "http://localhost:3000"));
  return checks;
}

async function deployChecks(): Promise<Check[]> {
  const section = "Release configuration";
  const env = read(".env.dokploy.local");
  if (!env) return [{ section, name: ".env.dokploy.local", status: "fail", detail: "missing", next: "cp .env.dokploy.example .env.dokploy.local and fill it in" }];
  // The provisioning script reads development-only fallbacks from apps/server/.env.
  const merged: Record<string, string | undefined> = { ...(read("apps/server/.env") ?? {}), ...env };
  const checks: Check[] = [];
  let policy: ReturnType<typeof parseDeployPolicy>;
  try {
    policy = parseDeployPolicy(env);
    checks.push({ section, name: "Policy", status: "ok", detail: `${policy.stage}; required: ${[...policy.required].join(", ") || "none"}` });
  } catch (error) {
    return [{ section, name: "Policy", status: "fail", detail: (error as Error).message }];
  }
  for (const key of ["DOKPLOY_URL", "DOKPLOY_API_KEY", "DOCKER_IMAGE_NAMESPACE", "DOCKER_REGISTRY_USERNAME", "DOCKER_REGISTRY_PASSWORD", "VITE_SERVER_URL", "VITE_WEB_URL", "PRODUCTION_BRAND_NAME"]) {
    if (!env[key]?.trim() || /replace-me|example\.com|your-github-user/.test(env[key]!)) {
      checks.push({ section, name: key, status: "fail", detail: "missing or still the example value" });
    }
  }
  if (checks.some((check) => check.status === "fail")) return checks;

  const infra = "Infrastructure";
  const dokploy = await http(`${env.DOKPLOY_URL!.replace(/\/+$/, "")}/api/trpc/project.all`, { headers: { "x-api-key": env.DOKPLOY_API_KEY! } });
  checks.push(dokploy.status === 200
    ? { section: infra, name: "Dokploy API", status: "ok", detail: `reachable, ${dokploy.json?.result?.data?.json?.length ?? 0} project(s)` }
    : { section: infra, name: "Dokploy API", status: "fail", detail: `returned ${dokploy.status || "no response"}`, next: "check DOKPLOY_URL and create an API key in Dokploy Settings → API/CLI" });
  const dokployIps = await resolve4(new URL(env.DOKPLOY_URL!).hostname).catch(() => [] as string[]);
  for (const key of ["VITE_WEB_URL", "VITE_SERVER_URL"] as const) {
    const host = new URL(env[key]!).hostname;
    const ips = await resolve4(host).catch(() => [] as string[]);
    checks.push(!ips.length
      ? { section: infra, name: `DNS ${host}`, status: "fail", detail: "does not resolve", next: `add an A record for ${host} pointing at the Dokploy server` }
      : dokployIps.length && !ips.some((ip) => dokployIps.includes(ip))
        ? { section: infra, name: `DNS ${host}`, status: "warn", detail: `resolves to ${ips.join(", ")}, not the Dokploy host (fine behind a proxy such as Cloudflare)` }
        : { section: infra, name: `DNS ${host}`, status: "ok", detail: ips.join(", ") });
  }
  const ghcr = await http(`https://ghcr.io/token?scope=repository:${env.DOCKER_IMAGE_NAMESPACE}/probe:pull,push&service=ghcr.io`, {
    headers: { Authorization: `Basic ${btoa(`${env.DOCKER_REGISTRY_USERNAME}:${env.DOCKER_REGISTRY_PASSWORD}`)}` },
  });
  checks.push(ghcr.status === 200
    ? { section: infra, name: "GHCR", status: "ok", detail: `credentials accepted for ghcr.io/${env.DOCKER_IMAGE_NAMESPACE}` }
    : { section: infra, name: "GHCR", status: "fail", detail: `credentials rejected (${ghcr.status || "no response"})`, next: "use a GitHub PAT with read:packages and write:packages" });
  const gh = Bun.spawnSync(["gh", "secret", "list", "--json", "name", "--jq", ".[].name"], { stdout: "pipe", stderr: "pipe" });
  if (gh.exitCode !== 0) {
    checks.push({ section: infra, name: "GitHub Actions", status: "warn", detail: "gh cannot read this repository's secrets", next: "gh auth login, then bun run deploy:github --apply" });
  } else {
    const names = new Set(gh.stdout.toString().split("\n").filter(Boolean));
    const missing = ["DOKPLOY_URL", "DOKPLOY_API_KEY", "DOKPLOY_MIGRATION_APPLICATION_ID", "DOKPLOY_SERVER_APPLICATION_ID", "DOKPLOY_WEB_APPLICATION_ID",
      "DOCKER_REGISTRY_USERNAME", "DOCKER_REGISTRY_PASSWORD", "VITE_SERVER_URL", "VITE_WEB_URL"].filter((name) => !names.has(name));
    checks.push(missing.length
      ? { section: infra, name: "GitHub Actions", status: "fail", detail: `missing secrets ${missing.join(", ")}`, next: "bun run deploy:provision, then bun run deploy:github --apply" }
      : { section: infra, name: "GitHub Actions", status: "ok", detail: "release secrets present" });
  }

  const services = "Services";
  const email = await emailChecks(merged, services, true);
  checks.push(...email.map((check) => (check.status === "fail" && !policy.required.has("email") && /no sender/.test(check.detail) ? { ...check, status: "off" as const } : check)));
  checks.push(...await stripeChecks(env, services, policy.stage === "production" ? "live" : "test", env.VITE_SERVER_URL, policy.required.has("stripe")));
  checks.push(...await storageChecks(env, services));
  checks.push(...await modelChecks(merged, services));
  checks.push(...configurationChecks(merged, services, env.VITE_SERVER_URL!).filter((check) => check.name !== "BETTER_AUTH_SECRET" || merged.BETTER_AUTH_SECRET));
  if (policy.required.has("posthog") && !env.POSTHOG_PROJECT_TOKEN?.trim()) {
    checks.push({ section: services, name: "Analytics (PostHog)", status: "fail", detail: "required by REQUIRED_INTEGRATIONS but not configured" });
  }
  return checks;
}

if (import.meta.main) {
  const checks = process.argv.includes("--deploy") ? await deployChecks() : await localChecks();
  console.log(render(checks));
  process.exit(exitCode(checks));
}
