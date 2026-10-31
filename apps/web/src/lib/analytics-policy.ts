import {
  isAnalyticsPrivacyMode,
  parseAnalyticsCountryCode,
  parseAnalyticsCountryCodes,
  type AnalyticsPrivacyMode,
} from "@northwind/env/analytics-privacy";

export type AnalyticsConsentPolicy = "opt_in" | "opt_out";
export type { AnalyticsPrivacyMode };

// Conservative baseline, not a claim that this is the complete legal map.
// Legal/product can extend it at runtime with ANALYTICS_OPT_IN_COUNTRIES.
export const DEFAULT_ANALYTICS_OPT_IN_COUNTRIES = [
  "AT",
  "BE",
  "BG",
  "CA",
  "CH",
  "CY",
  "CZ",
  "DE",
  "DK",
  "EE",
  "ES",
  "FI",
  "FR",
  "GB",
  "GR",
  "HR",
  "HU",
  "IE",
  "IS",
  "IT",
  "LI",
  "LT",
  "LU",
  "LV",
  "MT",
  "NL",
  "NO",
  "PL",
  "PT",
  "RO",
  "SE",
  "SI",
  "SK",
] as const;

export function parseAnalyticsPrivacyMode(
  value: unknown,
): AnalyticsPrivacyMode {
  return isAnalyticsPrivacyMode(value) ? value : "opt_in";
}

export function parseAnalyticsOptInCountries(
  value: string | null | undefined,
): ReadonlySet<string> {
  const configured = parseAnalyticsCountryCodes(value);

  if (!configured.length) {
    return new Set(DEFAULT_ANALYTICS_OPT_IN_COUNTRIES);
  }

  return new Set(configured);
}

export function resolveAnalyticsConsentPolicy(input: {
  countryCode?: unknown;
  mode: AnalyticsPrivacyMode;
  optInCountries?: ReadonlySet<string>;
}): AnalyticsConsentPolicy {
  if (input.mode !== "geo") return input.mode;

  const country = parseAnalyticsCountryCode(input.countryCode);
  if (!country) return "opt_in";

  const optInCountries =
    input.optInCountries ?? new Set(DEFAULT_ANALYTICS_OPT_IN_COUNTRIES);
  return optInCountries.has(country) ? "opt_in" : "opt_out";
}
