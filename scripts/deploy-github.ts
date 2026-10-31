/**
 * Copies the release configuration from .env.dokploy.local into this repository's GitHub
 * Actions secrets and variables (the names .github/workflows/deploy.yml reads). Run it after
 * `bun run deploy:provision`; it never prints secret values.
 *
 *   bun run deploy:github            # show what would be set
 *   bun run deploy:github --apply    # set it with the authenticated gh CLI
 */
import dotenv from "dotenv";

import { parseDeployPolicy } from "./deploy-config";

const file = new URL("../.env.dokploy.local", import.meta.url).pathname;
const local = dotenv.parse(await Bun.file(file).text().catch(() => ""));
const value = (key: string) => local[key]?.trim() || "";

/** Secret name → source key in .env.dokploy.local. */
export const SECRETS: Record<string, string> = {
  DOKPLOY_URL: "DOKPLOY_URL",
  DOKPLOY_API_KEY: "DOKPLOY_API_KEY",
  DOKPLOY_MIGRATION_APPLICATION_ID: "DOKPLOY_MIGRATION_APPLICATION_ID",
  DOKPLOY_SERVER_APPLICATION_ID: "DOKPLOY_SERVER_APPLICATION_ID",
  DOKPLOY_WEB_APPLICATION_ID: "DOKPLOY_WEB_APPLICATION_ID",
  DOKPLOY_WORKER_APPLICATION_ID: "DOKPLOY_WORKER_APPLICATION_ID",
  DOCKER_REGISTRY_USERNAME: "DOCKER_REGISTRY_USERNAME",
  DOCKER_REGISTRY_PASSWORD: "DOCKER_REGISTRY_PASSWORD",
  VITE_SERVER_URL: "VITE_SERVER_URL",
  VITE_WEB_URL: "VITE_WEB_URL",
  POSTHOG_PROJECT_TOKEN: "POSTHOG_PROJECT_TOKEN",
};
/** Variable name → source key. */
export const VARIABLES: Record<string, string> = {
  IMAGE_NAMESPACE: "DOCKER_IMAGE_NAMESPACE",
  PRODUCTION_BRAND_NAME: "PRODUCTION_BRAND_NAME",
  PRODUCTION_ENABLE_INDEXING: "PRODUCTION_ENABLE_INDEXING",
  VITE_POSTHOG_HOST: "VITE_POSTHOG_HOST",
  POSTHOG_HOST: "POSTHOG_HOST",
  DEPLOY_STAGE: "DEPLOY_STAGE",
  REQUIRED_INTEGRATIONS: "REQUIRED_INTEGRATIONS",
};
const REQUIRED = [
  "DOKPLOY_URL", "DOKPLOY_API_KEY", "DOKPLOY_MIGRATION_APPLICATION_ID", "DOKPLOY_SERVER_APPLICATION_ID",
  "DOKPLOY_WEB_APPLICATION_ID", "DOCKER_REGISTRY_USERNAME", "DOCKER_REGISTRY_PASSWORD", "VITE_SERVER_URL",
  "VITE_WEB_URL", "DOCKER_IMAGE_NAMESPACE", "PRODUCTION_BRAND_NAME",
];

if (import.meta.main) {
  const policy = parseDeployPolicy(local);
  const missing = REQUIRED.filter((key) => !value(key));
  if (policy.required.has("posthog") && !value("POSTHOG_PROJECT_TOKEN")) missing.push("POSTHOG_PROJECT_TOKEN");
  if (missing.length) {
    console.error(`Missing in .env.dokploy.local: ${missing.join(", ")}. Run bun run deploy:provision first for the application IDs.`);
    process.exit(1);
  }
  const apply = process.argv.includes("--apply");
  const gh = async (args: string[], input?: string) => {
    const child = Bun.spawn(["gh", ...args], { stdin: input === undefined ? "ignore" : new Blob([input]), stdout: "pipe", stderr: "pipe" });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(`gh ${args.slice(0, 3).join(" ")} failed: ${stderr.trim()}`);
  };
  for (const [name, source] of Object.entries(SECRETS)) {
    const secret = value(source);
    if (!secret) {
      console.log(`secret ${name}: (not set, skipped)`);
      continue;
    }
    console.log(`secret ${name}: set from ${source}`);
    if (apply) await gh(["secret", "set", name], secret);
  }
  for (const [name, source] of Object.entries(VARIABLES)) {
    const variable = value(source);
    if (!variable) {
      console.log(`variable ${name}: (not set, workflow default)`);
      continue;
    }
    console.log(`variable ${name}=${variable}`);
    if (apply) await gh(["variable", "set", name, "--body", variable]);
  }
  console.log(apply ? "GitHub Actions configuration saved. Push to main (bun run deploy:production) to release." : "Dry run. Re-run with --apply to save.");
}
