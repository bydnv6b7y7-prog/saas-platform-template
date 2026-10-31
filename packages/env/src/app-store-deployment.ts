import { z } from "zod";

import { appleApplicationLegacyIdentitySchema } from "./apple-application";
import { APP_STORE_CREDENTIAL_KEYS, APP_STORE_MAINTENANCE_KEYS, appStoreServerSchema } from "./app-store";

type DeploymentValues = Record<string, string | undefined>;

/** Production provisioning never imports Apple credentials from a development profile. */
export function appStoreDeploymentLines(production: DeploymentValues, existing: DeploymentValues = {}): string[] {
  const supplied = APP_STORE_CREDENTIAL_KEYS.filter((key) => production[key]?.trim());
  if (supplied.length > 0 && supplied.length !== APP_STORE_CREDENTIAL_KEYS.length) {
    throw new Error("Supply the complete App Store credential group when rotating production credentials");
  }
  const keys = [
    ...APP_STORE_CREDENTIAL_KEYS,
    "APP_STORE_ENABLED",
    "APP_STORE_ENVIRONMENTS",
    ...APP_STORE_MAINTENANCE_KEYS,
    ...Object.keys(appleApplicationLegacyIdentitySchema.shape),
  ];
  const selected: DeploymentValues = {};
  for (const key of keys) {
    const value = production[key]?.trim() ? production[key] : existing[key];
    if (value && /[\r\n]/.test(value)) throw new Error(`${key} must be a single-line deployment value`);
    selected[key] = value?.trim() || undefined;
  }
  const result = z.object(appStoreServerSchema).safeParse(selected);
  if (!result.success) {
    const invalidKeys = [...new Set(result.error.issues.map((issue) => issue.path.join(".")))];
    throw new Error(`Invalid App Store deployment configuration: ${invalidKeys.join(", ")}`);
  }
  const parsed = result.data;
  if (parsed.APP_STORE_ENABLED && APP_STORE_CREDENTIAL_KEYS.some((key) => !parsed[key])) {
    throw new Error("App Store credentials are incomplete; supply all three credentials or explicitly set APP_STORE_ENABLED=false");
  }
  const values: Record<string, string> = {
    APP_STORE_ENABLED: String(parsed.APP_STORE_ENABLED),
    APP_STORE_ENVIRONMENTS: parsed.APP_STORE_ENVIRONMENTS,
  };
  for (const key of APP_STORE_CREDENTIAL_KEYS) if (parsed[key]) values[key] = parsed[key];
  // Keep exceptional overrides without expanding the normal deployment surface.
  for (const key of APP_STORE_MAINTENANCE_KEYS) if (selected[key]) values[key] = String(parsed[key]);
  return Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(value)}`);
}
