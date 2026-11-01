import { z } from "zod";

export const APP_STORE_CREDENTIAL_KEYS = [
  "APP_STORE_ISSUER_ID",
  "APP_STORE_KEY_ID",
  "APP_STORE_PRIVATE_KEY_BASE64",
] as const;

export const APP_STORE_MAINTENANCE_KEYS = [
  "APP_STORE_REVERIFY_INTERVAL_SECONDS",
  "APP_STORE_RECONCILE_INTERVAL_SECONDS",
] as const;

export const APP_STORE_MAINTENANCE_DEFAULTS = {
  reverifyIntervalSeconds: 900,
  reconcileIntervalSeconds: 21600,
} as const;

export const APP_STORE_ENVIRONMENTS = ["Production", "Sandbox"] as const;
const appStoreEnvironmentSchema = z.enum(APP_STORE_ENVIRONMENTS);
export type AppStoreEnvironment = z.infer<typeof appStoreEnvironmentSchema>;

export const appStoreEnvironmentsSchema = z.string().default("Production").transform((value, context) => {
  const environments = [...new Set(value.split(",").map((environment) => environment.trim()))];
  if (environments.some((environment) => !appStoreEnvironmentSchema.safeParse(environment).success)) {
    context.addIssue({ code: "custom", message: "APP_STORE_ENVIRONMENTS must contain Production and/or Sandbox" });
    return z.NEVER;
  }
  return environments as AppStoreEnvironment[];
});

export function parseAppStoreEnvironments(value?: string): AppStoreEnvironment[] {
  return appStoreEnvironmentsSchema.parse(value);
}

/** Advanced deployment overrides. Normal deployments use these shared defaults. */
export const appStoreMaintenanceSchema = z.object({
  APP_STORE_REVERIFY_INTERVAL_SECONDS: z.coerce.number().int().min(300).max(21600).default(APP_STORE_MAINTENANCE_DEFAULTS.reverifyIntervalSeconds),
  APP_STORE_RECONCILE_INTERVAL_SECONDS: z.coerce.number().int().positive().max(86400).default(APP_STORE_MAINTENANCE_DEFAULTS.reconcileIntervalSeconds),
});

export const appStoreServerSchema = {
  // Enabled normally; an explicit false is the operational emergency switch.
  APP_STORE_ENABLED: z.enum(["true", "false"]).default("true").transform(value => value === "true"),
  APP_STORE_ISSUER_ID: z.string().trim().min(1).optional(),
  APP_STORE_KEY_ID: z.string().trim().min(1).optional(),
  APP_STORE_PRIVATE_KEY_BASE64: z.string().min(1).optional(),
  APP_STORE_ENVIRONMENTS: appStoreEnvironmentsSchema.transform((environments) => environments.join(",")),
  ...appStoreMaintenanceSchema.shape,
};
