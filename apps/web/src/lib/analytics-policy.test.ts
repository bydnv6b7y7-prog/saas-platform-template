import { describe, expect, test } from "bun:test";

import {
  parseAnalyticsOptInCountries,
  parseAnalyticsPrivacyMode,
  resolveAnalyticsConsentPolicy,
} from "./analytics-policy";

describe("analytics privacy policy", () => {
  test("fails closed for missing or invalid configuration", () => {
    expect(parseAnalyticsPrivacyMode(undefined)).toBe("opt_in");
    expect(parseAnalyticsPrivacyMode("invalid")).toBe("opt_in");
    expect(
      resolveAnalyticsConsentPolicy({ mode: "geo", countryCode: undefined }),
    ).toBe("opt_in");
    expect(
      resolveAnalyticsConsentPolicy({ mode: "geo", countryCode: "XX" }),
    ).toBe("opt_in");
  });

  test("uses opt-in in the configured strict regions and opt-out elsewhere", () => {
    const optInCountries = parseAnalyticsOptInCountries("DE,GB, ch");
    expect(
      resolveAnalyticsConsentPolicy({
        mode: "geo",
        countryCode: "de",
        optInCountries,
      }),
    ).toBe("opt_in");
    expect(
      resolveAnalyticsConsentPolicy({
        mode: "geo",
        countryCode: "US",
        optInCountries,
      }),
    ).toBe("opt_out");
  });

  test("rejects a partially invalid strict-region override", () => {
    expect(() => parseAnalyticsOptInCountries("DE,GB,invalid")).toThrow(
      "ANALYTICS_OPT_IN_COUNTRIES contains an invalid country code",
    );
  });

  test("keeps Canada in the conservative default region set", () => {
    expect(
      resolveAnalyticsConsentPolicy({ mode: "geo", countryCode: "CA" }),
    ).toBe("opt_in");
  });

  test("supports explicit deployment-wide policies", () => {
    expect(
      resolveAnalyticsConsentPolicy({ mode: "opt_in", countryCode: "US" }),
    ).toBe("opt_in");
    expect(
      resolveAnalyticsConsentPolicy({ mode: "opt_out", countryCode: "DE" }),
    ).toBe("opt_out");
  });
});
