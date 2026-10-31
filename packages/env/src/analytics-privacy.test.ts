import { describe, expect, test } from "bun:test";

import {
  isAnalyticsPrivacyMode,
  parseAnalyticsCountryCode,
  parseAnalyticsCountryCodes,
} from "./analytics-privacy";

describe("analytics privacy configuration", () => {
  test("accepts only supported regional privacy modes", () => {
    for (const mode of ["opt_in", "opt_out", "geo"]) {
      expect(isAnalyticsPrivacyMode(mode)).toBe(true);
    }
    expect(isAnalyticsPrivacyMode("automatic")).toBe(false);
    expect(isAnalyticsPrivacyMode(undefined)).toBe(false);
  });

  test("normalizes country overrides and rejects partial invalid input", () => {
    expect(parseAnalyticsCountryCode(" ch ")).toBe("CH");
    expect(parseAnalyticsCountryCode("XX")).toBeNull();
    expect(parseAnalyticsCountryCodes("DE, gb, CH,")).toEqual([
      "DE",
      "GB",
      "CH",
    ]);
    expect(() => parseAnalyticsCountryCodes("DE,invalid")).toThrow(
      "ANALYTICS_OPT_IN_COUNTRIES contains an invalid country code",
    );
  });
});
