/**
 * Adds or updates the Northwind feedback settings on the production API application
 * without re-provisioning anything else (docs/app-feedback-rating.md):
 * R2_* for screenshots (all four or none) and FEEDBACK_NOTIFY_EMAIL.
 *
 *   bun scripts/dokploy-feedback-env.ts          # show what would change
 *   bun scripts/dokploy-feedback-env.ts --apply  # save it
 *
 * Values come from .env.dokploy.local; every other variable of the application
 * is kept exactly as it is. Nothing is deployed: the next release (or a manual
 * redeploy of the server) picks the environment up. Secret values are never printed.
 */
import dotenv from "dotenv";

dotenv.config({ path: new URL("../.env.dokploy.local", import.meta.url).pathname });

const BASE = process.env.DOKPLOY_URL?.replace(/\/+$/, "");
const KEY = process.env.DOKPLOY_API_KEY;
const APPLICATION = process.env.DOKPLOY_SERVER_APPLICATION_ID;
if (!BASE || !KEY || !APPLICATION) {
  throw new Error("DOKPLOY_URL, DOKPLOY_API_KEY and DOKPLOY_SERVER_APPLICATION_ID must be set in .env.dokploy.local");
}

const storageKeys = ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_ENDPOINT"] as const;
const present = storageKeys.filter((key) => process.env[key]?.trim());
if (present.length > 0 && present.length < storageKeys.length) {
  throw new Error(`Incomplete R2 configuration in .env.dokploy.local: ${storageKeys.join(", ")} go together`);
}
const wanted: Record<string, string> = {};
if (present.length) {
  for (const key of storageKeys) wanted[key] = process.env[key]!.trim();
  if (process.env.R2_REGION?.trim()) wanted.R2_REGION = process.env.R2_REGION.trim();
}
if (process.env.FEEDBACK_NOTIFY_EMAIL?.trim()) wanted.FEEDBACK_NOTIFY_EMAIL = process.env.FEEDBACK_NOTIFY_EMAIL.trim();
if (!Object.keys(wanted).length) throw new Error("Nothing to set: no R2_* or FEEDBACK_NOTIFY_EMAIL in .env.dokploy.local");

async function trpc<T>(path: string, input: unknown, method: "GET" | "POST"): Promise<T> {
  const url = method === "GET"
    ? `${BASE}/api/trpc/${path}?input=${encodeURIComponent(JSON.stringify({ json: input }))}`
    : `${BASE}/api/trpc/${path}`;
  const response = await fetch(url, {
    method,
    headers: { "x-api-key": KEY!, ...(method === "POST" ? { "Content-Type": "application/json" } : {}) },
    body: method === "POST" ? JSON.stringify({ json: input }) : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} failed with ${response.status}`);
  return (JSON.parse(text) as { result: { data: { json: T } } }).result.data.json;
}

const application = await trpc<{ name: string; env?: string | null }>("application.one", { applicationId: APPLICATION }, "GET");
if (application.name !== "northwind-server") throw new Error(`Refusing: application is ${application.name}, not northwind-server`);
const current = dotenv.parse(application.env ?? "");
const lines = (application.env ?? "").split("\n");
const changes: string[] = [];
for (const [key, value] of Object.entries(wanted)) {
  const line = `${key}=${JSON.stringify(value)}`;
  const index = lines.findIndex((existing) => existing.startsWith(`${key}=`));
  if (index === -1) {
    lines.push(line);
    changes.push(`add ${key}`);
  } else if (current[key] !== value) {
    lines[index] = line;
    changes.push(`update ${key}`);
  }
}
if (!changes.length) {
  console.log("Already set; nothing to change.");
  process.exit(0);
}
console.log(changes.join("\n"));
if (!process.argv.includes("--apply")) {
  console.log("Dry run. Re-run with --apply to save.");
  process.exit(0);
}
await trpc("application.saveEnvironment", {
  applicationId: APPLICATION,
  env: lines.filter((line, index) => line || index < lines.length - 1).join("\n"),
  buildArgs: "",
  buildSecrets: "",
  createEnvFile: false,
}, "POST");
const saved = dotenv.parse((await trpc<{ env?: string | null }>("application.one", { applicationId: APPLICATION }, "GET")).env ?? "");
for (const [key, value] of Object.entries(wanted)) {
  if (saved[key] !== value) throw new Error(`${key} did not persist`);
}
console.log(`Saved ${changes.length} change(s). Takes effect on the next server deployment.`);
