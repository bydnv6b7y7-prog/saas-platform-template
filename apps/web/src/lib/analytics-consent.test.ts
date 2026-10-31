import { describe, expect, test } from "bun:test";

import {
  ANALYTICS_CONSENT_STORAGE_KEY,
  commitAnalyticsConsent,
  hasAnalyticsPrivacySignal,
  isAnalyticsConsentStorageEventKey,
  parseAnalyticsConsent,
  resolveAnalyticsConsent,
} from "./analytics-consent";

describe("analytics consent", () => {
  test("requires an explicit valid decision", () => {
    expect(parseAnalyticsConsent(null)).toBe("pending");
    expect(parseAnalyticsConsent("granted")).toBe("granted");
    expect(parseAnalyticsConsent("denied")).toBe("denied");
    expect(parseAnalyticsConsent("true")).toBe("pending");
  });

  test("lets browser privacy signals override stored consent", () => {
    expect(resolveAnalyticsConsent("granted", true)).toBe("denied");
    expect(resolveAnalyticsConsent("granted", false)).toBe("granted");
  });

  test("applies regional defaults without overriding an explicit choice", () => {
    expect(resolveAnalyticsConsent(null, false, "opt_in")).toBe("pending");
    expect(resolveAnalyticsConsent(null, false, "opt_out")).toBe("granted");
    expect(resolveAnalyticsConsent("denied", false, "opt_out")).toBe("denied");
    expect(resolveAnalyticsConsent("granted", false, "opt_in")).toBe("granted");
    expect(resolveAnalyticsConsent(null, true, "opt_out")).toBe("denied");
  });

  test("recognizes GPC and common Do Not Track signals", () => {
    expect(
      hasAnalyticsPrivacySignal({
        doNotTrack: null,
        globalPrivacyControl: true,
      }),
    ).toBe(true);
    expect(
      hasAnalyticsPrivacySignal({
        doNotTrack: "1",
      }),
    ).toBe(true);
    expect(
      hasAnalyticsPrivacySignal({
        doNotTrack: null,
        msDoNotTrack: "1",
      }),
    ).toBe(true);
    expect(hasAnalyticsPrivacySignal({ doNotTrack: "yes" })).toBe(true);
    expect(hasAnalyticsPrivacySignal({ doNotTrack: "0" })).toBe(false);
  });

  test("reacts to consent updates and cross-tab local storage clears", () => {
    expect(
      isAnalyticsConsentStorageEventKey(ANALYTICS_CONSENT_STORAGE_KEY),
    ).toBe(true);
    expect(isAnalyticsConsentStorageEventKey(null)).toBe(true);
    expect(isAnalyticsConsentStorageEventKey("unrelated.preference")).toBe(
      false,
    );
  });

  test("keeps a committed decision even when analytics cleanup fails", () => {
    expect(
      commitAnalyticsConsent("denied", () => {
        throw new Error("storage unavailable");
      }),
    ).toBe("denied");
  });
});
