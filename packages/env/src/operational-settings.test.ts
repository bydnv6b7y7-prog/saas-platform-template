import { describe, expect, test } from "bun:test";

import { OPERATIONAL_SETTINGS_DEFAULTS, operationalSettingsSchema } from "./operational-settings";

describe("operational settings contract", () => {
  test("accepts the defaults and never a zero assistant allowance", () => {
    expect(operationalSettingsSchema.parse(OPERATIONAL_SETTINGS_DEFAULTS)).toEqual(OPERATIONAL_SETTINGS_DEFAULTS);
    expect(operationalSettingsSchema.safeParse({ ...OPERATIONAL_SETTINGS_DEFAULTS, assistantFreePerDay: 0 }).success).toBe(false);
  });

  test("rejects partial snapshots, extra keys, non-integers, and out-of-range values", () => {
    for (const values of [
      { assistantFreePerDay: 10 },
      { ...OPERATIONAL_SETTINGS_DEFAULTS, secret: "must-not-survive" },
      { ...OPERATIONAL_SETTINGS_DEFAULTS, ingestLookupLimit: 50 },
      { ...OPERATIONAL_SETTINGS_DEFAULTS, assistantFreePerDay: 1.5 },
      { ...OPERATIONAL_SETTINGS_DEFAULTS, assistantProPerDay: 10_001 },
      { ...OPERATIONAL_SETTINGS_DEFAULTS, assistantFreePer5Minutes: "10" },
    ]) expect(operationalSettingsSchema.safeParse(values).success).toBe(false);
  });
});
