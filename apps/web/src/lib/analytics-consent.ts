import type { AnalyticsConsentPolicy } from "./analytics-policy";
import { IDENTIFIER_PREFIX } from "@northwind/env/brand";

export const ANALYTICS_CONSENT_STORAGE_KEY =
  `${IDENTIFIER_PREFIX}.analytics-consent.v1`;

export type AnalyticsConsent = "pending" | "granted" | "denied";
export type AnalyticsConsentDecision = Exclude<AnalyticsConsent, "pending">;

const ANALYTICS_CONSENT_EVENT = "analytics-consent-change";
let volatileConsent: AnalyticsConsent = "pending";
let hasVolatileConsent = false;

type PrivacyNavigator = Pick<Navigator, "doNotTrack"> & {
  globalPrivacyControl?: boolean;
  msDoNotTrack?: string | null;
};

export function parseAnalyticsConsent(value: string | null): AnalyticsConsent {
  return value === "granted" || value === "denied" ? value : "pending";
}

export function hasAnalyticsPrivacySignal(
  navigatorValue: PrivacyNavigator | null | undefined,
): boolean {
  const doNotTrack = navigatorValue?.doNotTrack?.toLowerCase();
  const microsoftDoNotTrack = navigatorValue?.msDoNotTrack?.toLowerCase();
  return Boolean(
    navigatorValue?.globalPrivacyControl ||
      doNotTrack === "1" ||
      doNotTrack === "yes" ||
      microsoftDoNotTrack === "1" ||
      microsoftDoNotTrack === "yes",
  );
}

export function resolveAnalyticsConsent(
  storedValue: string | null,
  privacySignal: boolean,
  policy: AnalyticsConsentPolicy = "opt_in",
): AnalyticsConsent {
  if (privacySignal) return "denied";
  const preference = parseAnalyticsConsent(storedValue);
  return preference === "pending" && policy === "opt_out"
    ? "granted"
    : preference;
}

export function getAnalyticsConsentPolicy(): AnalyticsConsentPolicy {
  if (typeof document === "undefined") return "opt_in";
  return document.documentElement.dataset.analyticsConsentPolicy === "opt_out"
    ? "opt_out"
    : "opt_in";
}

function browserPrivacySignal(): boolean {
  return typeof navigator !== "undefined"
    ? hasAnalyticsPrivacySignal(navigator as PrivacyNavigator)
    : false;
}

function browserStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function getAnalyticsConsentPreference(): AnalyticsConsent {
  if (typeof window === "undefined") return "pending";

  const storage = browserStorage();
  if (storage) {
    try {
      const storedConsent = storage.getItem(ANALYTICS_CONSENT_STORAGE_KEY);
      if (storedConsent !== null || !hasVolatileConsent) {
        volatileConsent = parseAnalyticsConsent(storedConsent);
        hasVolatileConsent = storedConsent !== null;
      }
    } catch {
      // A session-only decision still works when browser storage is unavailable.
    }
  }

  return volatileConsent;
}

export function getAnalyticsConsent(): AnalyticsConsent {
  return resolveAnalyticsConsent(
    getAnalyticsConsentPreference(),
    browserPrivacySignal(),
    getAnalyticsConsentPolicy(),
  );
}

export function commitAnalyticsConsent(
  decision: AnalyticsConsentDecision,
  beforeNotify?: (consent: AnalyticsConsentDecision) => void,
): AnalyticsConsentDecision {
  const effectiveDecision =
    decision === "granted" && browserPrivacySignal() ? "denied" : decision;
  volatileConsent = effectiveDecision;
  hasVolatileConsent = true;

  const storage = browserStorage();
  if (storage) {
    try {
      storage.setItem(ANALYTICS_CONSENT_STORAGE_KEY, effectiveDecision);
    } catch {
      // Keep the decision in memory for the current page when persistence fails.
    }
  }

  try {
    beforeNotify?.(effectiveDecision);
  } catch {
    // Consent is already committed; analytics cleanup must not break product UI.
  } finally {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event(ANALYTICS_CONSENT_EVENT));
    }
  }
  return effectiveDecision;
}

export function isAnalyticsConsentStorageEventKey(
  key: string | null,
): boolean {
  return key === null || key === ANALYTICS_CONSENT_STORAGE_KEY;
}

export function subscribeAnalyticsConsent(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;

  const localStorage = browserStorage();
  const onStorage = (event: StorageEvent) => {
    if (
      event.storageArea !== localStorage ||
      !isAnalyticsConsentStorageEventKey(event.key)
    ) {
      return;
    }

    const storedValue = event.key === null ? null : event.newValue;
    volatileConsent = parseAnalyticsConsent(storedValue);
    hasVolatileConsent = storedValue !== null;
    onChange();
  };
  window.addEventListener(ANALYTICS_CONSENT_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(ANALYTICS_CONSENT_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function analyticsConsentServerSnapshot(): AnalyticsConsent {
  return "pending";
}

export function isAnalyticsPrivacySignalActive(): boolean {
  return browserPrivacySignal();
}
