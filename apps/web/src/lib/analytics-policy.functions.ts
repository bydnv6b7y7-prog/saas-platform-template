import { createServerFn } from "@tanstack/react-start";
import {
  getRequestHeader,
  setResponseHeader,
} from "@tanstack/react-start/server";

import {
  parseAnalyticsOptInCountries,
  parseAnalyticsPrivacyMode,
  resolveAnalyticsConsentPolicy,
} from "./analytics-policy";

/**
 * Resolve only the policy class on the server. The browser never supplies or
 * receives the visitor country. Missing/invalid proxy data fails closed.
 */
export const getRequestAnalyticsConsentPolicy = createServerFn({ method: "GET" })
  .handler(() => {
    setResponseHeader("Cache-Control", "private, no-store");
    setResponseHeader("Vary", "CF-IPCountry");
    const mode = parseAnalyticsPrivacyMode(
      process.env.ANALYTICS_PRIVACY_MODE,
    );
    return resolveAnalyticsConsentPolicy({
      mode,
      countryCode: mode === "geo" ? getRequestHeader("cf-ipcountry") : null,
      optInCountries: parseAnalyticsOptInCountries(
        process.env.ANALYTICS_OPT_IN_COUNTRIES,
      ),
    });
  });
