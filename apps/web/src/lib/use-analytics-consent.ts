import { useSyncExternalStore } from "react";

import {
  analyticsConsentServerSnapshot,
  getAnalyticsConsent,
  getAnalyticsConsentPolicy,
  getAnalyticsConsentPreference,
  isAnalyticsPrivacySignalActive,
  subscribeAnalyticsConsent,
} from "./analytics-consent";
import type { AnalyticsConsentPolicy } from "./analytics-policy";

const subscribeStaticValue = () => () => undefined;

export function useAnalyticsConsent() {
  return useSyncExternalStore(
    subscribeAnalyticsConsent,
    getAnalyticsConsent,
    analyticsConsentServerSnapshot,
  );
}

export function useAnalyticsConsentPreference() {
  return useSyncExternalStore(
    subscribeAnalyticsConsent,
    getAnalyticsConsentPreference,
    analyticsConsentServerSnapshot,
  );
}

export function useAnalyticsConsentPolicy(): AnalyticsConsentPolicy {
  return useSyncExternalStore(
    subscribeStaticValue,
    getAnalyticsConsentPolicy,
    () => "opt_in",
  );
}

export function useAnalyticsPrivacySignal(): boolean {
  return useSyncExternalStore(
    subscribeAnalyticsConsent,
    isAnalyticsPrivacySignalActive,
    () => false,
  );
}
