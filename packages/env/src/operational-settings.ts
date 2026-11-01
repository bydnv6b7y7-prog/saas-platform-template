import { z } from "zod";

/** Public, environment-independent contract for the platform's assistant usage controls. */
export const operationalSettingsSchema = z.strictObject({
  assistantFreePer5Minutes: z.number().int().min(1).max(1_000),
  assistantFreePerDay: z.number().int().min(1).max(10_000),
  assistantProPer5Minutes: z.number().int().min(1).max(1_000),
  assistantProPerDay: z.number().int().min(1).max(10_000),
});

export type OperationalSettings = z.infer<typeof operationalSettingsSchema>;

export const OPERATIONAL_SETTINGS_DEFAULTS: Readonly<OperationalSettings> = Object.freeze({
  assistantFreePer5Minutes: 5,
  assistantFreePerDay: 5,
  assistantProPer5Minutes: 10,
  assistantProPerDay: 100,
});

/** A deployment variable for one runtime setting: blank means the setting's default, bounds stay in its schema. */
export function deploymentSetting(schema: z.ZodNumber, fallback: number) {
  return z.preprocess(
    (value) => value === undefined || (typeof value === "string" && value.trim() === "") ? fallback : value,
    z.coerce.number().pipe(schema),
  );
}

const setting = (key: keyof OperationalSettings) =>
  deploymentSetting(operationalSettingsSchema.shape[key], OPERATIONAL_SETTINGS_DEFAULTS[key]);

/** Compatibility inputs during migration; bounds and defaults stay in this contract. */
export const operationalSettingsEnvSchema = z.object({
  ASSISTANT_FREE_RUN_LIMIT_PER_5M: setting("assistantFreePer5Minutes"),
  ASSISTANT_FREE_RUN_LIMIT_PER_DAY: setting("assistantFreePerDay"),
  ASSISTANT_PRO_RUN_LIMIT_PER_5M: setting("assistantProPer5Minutes"),
  ASSISTANT_PRO_RUN_LIMIT_PER_DAY: setting("assistantProPerDay"),
});

export function operationalSettingsFromEnvironment(input: Record<string, unknown>): OperationalSettings {
  const parsed = operationalSettingsEnvSchema.parse(input);
  return {
    assistantFreePer5Minutes: parsed.ASSISTANT_FREE_RUN_LIMIT_PER_5M,
    assistantFreePerDay: parsed.ASSISTANT_FREE_RUN_LIMIT_PER_DAY,
    assistantProPer5Minutes: parsed.ASSISTANT_PRO_RUN_LIMIT_PER_5M,
    assistantProPerDay: parsed.ASSISTANT_PRO_RUN_LIMIT_PER_DAY,
  };
}
