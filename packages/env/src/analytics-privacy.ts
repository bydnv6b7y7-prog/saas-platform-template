export const ANALYTICS_PRIVACY_MODES = ["opt_in", "opt_out", "geo"] as const;
export type AnalyticsPrivacyMode = (typeof ANALYTICS_PRIVACY_MODES)[number];

export function isAnalyticsPrivacyMode(
  value: unknown,
): value is AnalyticsPrivacyMode {
  return (
    typeof value === "string" &&
    (ANALYTICS_PRIVACY_MODES as readonly string[]).includes(value)
  );
}

export function parseAnalyticsCountryCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalized) || normalized === "XX") return null;
  return normalized;
}

export function parseAnalyticsCountryCodes(
  value: string | null | undefined,
): readonly string[] {
  const configured = value
    ?.split(",")
    .map((country) => country.trim())
    .filter(Boolean) ?? [];
  const parsed = configured.map(parseAnalyticsCountryCode);

  if (!parsed.every((country): country is string => country !== null)) {
    throw new Error("ANALYTICS_OPT_IN_COUNTRIES contains an invalid country code");
  }

  return parsed;
}
