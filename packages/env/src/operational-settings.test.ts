import { describe, expect, test } from "bun:test";

import { OPERATIONAL_SETTINGS_DEFAULTS, operationalSettingsFromEnvironment, operationalSettingsSchema } from "./operational-settings";

describe("operational settings contract", () => {
  test("shares safe defaults and preserves explicit deployment overrides", () => {
    expect(operationalSettingsFromEnvironment({})).toEqual(OPERATIONAL_SETTINGS_DEFAULTS);
    expect(operationalSettingsFromEnvironment({ ASSISTANT_PRO_RUN_LIMIT_PER_DAY: "200", ASSISTANT_FREE_RUN_LIMIT_PER_5M: "7" }))
      .toMatchObject({ assistantProPerDay: 200, assistantFreePer5Minutes: 7 });
    expect(operationalSettingsFromEnvironment({ ASSISTANT_PRO_RUN_LIMIT_PER_DAY: " ", ASSISTANT_FREE_RUN_LIMIT_PER_DAY: "" }))
      .toEqual(OPERATIONAL_SETTINGS_DEFAULTS);
  });

  test("never allows a zero assistant allowance", () => {
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
    expect(() => operationalSettingsFromEnvironment({ ASSISTANT_FREE_RUN_LIMIT_PER_DAY: "1.5" })).toThrow();
    expect(() => operationalSettingsFromEnvironment({ ASSISTANT_PRO_RUN_LIMIT_PER_5M: "1001" })).toThrow();
  });
});
