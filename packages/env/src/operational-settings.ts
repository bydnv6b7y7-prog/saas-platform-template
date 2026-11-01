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
