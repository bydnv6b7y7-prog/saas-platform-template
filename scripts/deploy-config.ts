import { readFileSync, writeFileSync } from "node:fs";

export const INTEGRATIONS = ["email", "stripe", "posthog"] as const;
export type Integration = (typeof INTEGRATIONS)[number];

/**
 * DEPLOY_STAGE picks the Stripe key mode a deployment accepts (production = Live, staging = Test).
 * REQUIRED_INTEGRATIONS lists integrations whose absence must stop a release; any other integration
 * is simply left off when its whole variable group is empty.
 */
export function parseDeployPolicy(env: Record<string, string | undefined>) {
  const stage = (env.DEPLOY_STAGE?.trim() || "production") as "production" | "staging";
  if (stage !== "production" && stage !== "staging") throw new Error("DEPLOY_STAGE must be production or staging");
  const listed = (env.REQUIRED_INTEGRATIONS ?? "email").split(",").map((value) => value.trim()).filter(Boolean);
  const unknown = listed.filter((value) => !(INTEGRATIONS as readonly string[]).includes(value));
  if (unknown.length) throw new Error(`REQUIRED_INTEGRATIONS has unknown entries: ${unknown.join(", ")} (allowed: ${INTEGRATIONS.join(", ")})`);
  return { stage, required: new Set(listed as Integration[]) };
}

/** Later lines replace earlier lines with the same key, keeping the first position. */
export function mergeEnvLines(base: string[], overrides: string[]): string[] {
  const key = (line: string) => line.slice(0, line.indexOf("="));
  const replaced = new Map(overrides.map((line) => [key(line), line]));
  const merged = base.map((line) => replaced.get(key(line)) ?? line);
  const present = new Set(base.map(key));
  return [...merged, ...overrides.filter((line) => !present.has(key(line)))];
}

/** Sets KEY=value in a dotenv file, replacing an existing line or appending one. */
export function setEnvFileValue(path: string, key: string, value: string): void {
  if (/[\r\n]/.test(value)) throw new Error(`${key} must be a single-line value`);
  const current = readFileSync(path, "utf8");
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  writeFileSync(path, pattern.test(current) ? current.replace(pattern, () => line) : `${current.trimEnd()}\n${line}\n`);
}
