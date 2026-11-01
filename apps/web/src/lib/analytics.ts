import type {
  AnalyticsEventMap,
  AnalyticsEventName,
} from "@northwind/analytics";
import { POSTHOG_UI_HOST } from "@northwind/env/posthog";
import { env } from "@northwind/env/web";
import type {
  CaptureOptions,
  CaptureResult,
  PostHog,
} from "posthog-js/dist/module.slim";

import {
  commitAnalyticsConsent,
  getAnalyticsConsent,
  type AnalyticsConsent,
  type AnalyticsConsentDecision,
} from "./analytics-consent";

type AnalyticsIdentityAction = "none" | "identify" | "reset" | "reset_and_identify";
type AnalyticsProperties = CaptureResult["properties"];

const URL_PROPERTY_KEYS = [
  "$current_url",
  "$referrer",
  "$session_entry_url",
  "$session_entry_referrer",
  "$initial_current_url",
  "$initial_referrer",
] as const;
const PATH_PROPERTY_KEYS = [
  "$pathname",
  "$session_entry_pathname",
  "$initial_pathname",
] as const;
const SEARCH_TERM_PROPERTY_KEYS = [
  "ph_keyword",
  "$initial_ph_keyword",
  "$session_entry_ph_keyword",
] as const;
const INITIAL_PERSON_INFO_URL_KEYS = ["r", "u"] as const;
const POSTHOG_CONSENT_STORAGE_PREFIX = "__ph_opt_in_out_";

let analyticsClient: PostHog | null = null;
let analyticsLoad: Promise<PostHog | null> | null = null;
let analyticsDisabled = false;
let analyticsCapturing = false;
let analyticsIdentityReady = false;

type AnalyticsIdentityClient = Pick<
  PostHog,
  "identify" | "opt_in_capturing" | "reset"
>;
type AnalyticsIdentityReader = Pick<
  PostHog,
  "get_distinct_id" | "get_property"
>;
type AnalyticsStorage = Pick<
  Storage,
  "key" | "length" | "removeItem" | "setItem"
>;

function resetAndResumeAnalytics(
  client: AnalyticsIdentityClient,
  resetDeviceId = false,
): void {
  if (resetDeviceId) client.reset(true);
  else client.reset();
  client.opt_in_capturing({ captureEventName: false });
  analyticsCapturing = true;
}

function clearAndDisableAnalytics(client: PostHog): void {
  client.reset(true);
  client.persistence?.clear();
  client.sessionPersistence?.clear();
  client.opt_out_capturing();
  analyticsCapturing = false;
  analyticsIdentityReady = false;
}

export function clearPostHogTokenStorage(
  storage: AnalyticsStorage,
  projectToken: string,
): void {
  const persistenceKey = `ph_${projectToken}_posthog`;
  const keys = [
    persistenceKey,
    `${persistenceKey}__flags`,
    `${persistenceKey}__surveys`,
    `${persistenceKey}_cookie_identity_change_pending`,
    `ph_${projectToken}_primary_window_exists`,
    `ph_${projectToken}_session_registered_properties`,
    `ph_${projectToken}_window_id`,
    `ph_conv_${projectToken}`,
  ];
  for (const key of keys) storage.removeItem(key);
}

export function persistPostHogConsent(
  storage: AnalyticsStorage,
  projectToken: string,
  consent: AnalyticsConsentDecision,
): void {
  if (consent === "denied") {
    clearPostHogTokenStorage(storage, projectToken);
  }
  storage.setItem(
    `${POSTHOG_CONSENT_STORAGE_PREFIX}${projectToken}`,
    consent === "granted" ? "1" : "0",
  );
}

function browserStorage(
  name: "localStorage" | "sessionStorage",
): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window[name];
  } catch {
    return null;
  }
}

function persistBrowserPostHogConsent(
  consent: AnalyticsConsentDecision,
): void {
  const projectToken = env.VITE_POSTHOG_PROJECT_TOKEN;
  if (!projectToken) return;

  const localStorage = browserStorage("localStorage");
  if (localStorage) {
    try {
      persistPostHogConsent(localStorage, projectToken, consent);
    } catch {
      // A volatile app-level decision still applies when browser storage fails.
    }
  }
  if (consent === "denied") {
    const sessionStorage = browserStorage("sessionStorage");
    if (sessionStorage) {
      try {
        clearPostHogTokenStorage(sessionStorage, projectToken);
      } catch {
        // PostHog remains disabled even when browser storage cleanup fails.
      }
    }
  }
}

export function sanitizeAnalyticsUrl(value: string): string {
  if (value === "$direct") return value;

  try {
    const url = new URL(value, "https://analytics.invalid");
    if (url.origin !== "https://analytics.invalid" && !["http:", "https:"].includes(url.protocol)) {
      return "redacted";
    }
    if (/^\/s\/[^/]+/.test(url.pathname)) url.pathname = "/s/redacted";
    url.username = "";
    url.password = "";
    url.hash = "";
    url.search = "";

    return url.origin === "https://analytics.invalid"
      ? url.pathname
      : url.toString();
  } catch {
    return "redacted";
  }
}

function sanitizeInitialPersonInfo(
  value: unknown,
): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const source = value as Record<string, unknown>;
  const sanitized: Record<string, string> = {};
  for (const key of INITIAL_PERSON_INFO_URL_KEYS) {
    if (typeof source[key] === "string") {
      sanitized[key] = sanitizeAnalyticsUrl(source[key]);
    }
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

export function sanitizeAnalyticsProperties(
  properties: AnalyticsProperties,
): AnalyticsProperties {
  const sanitized = { ...properties };
  for (const key of [...URL_PROPERTY_KEYS, ...PATH_PROPERTY_KEYS]) {
    if (typeof sanitized[key] === "string") {
      sanitized[key] = sanitizeAnalyticsUrl(sanitized[key]);
    }
  }
  for (const key of SEARCH_TERM_PROPERTY_KEYS) delete sanitized[key];

  const initialPersonInfo = sanitizeInitialPersonInfo(
    sanitized.$initial_person_info,
  );
  if (initialPersonInfo) {
    sanitized.$initial_person_info = initialPersonInfo;
  } else {
    delete sanitized.$initial_person_info;
  }

  return sanitized;
}

export function sanitizeAnalyticsCapture(
  result: CaptureResult | null,
): CaptureResult | null {
  if (!result) return null;

  const sanitized: CaptureResult = {
    ...result,
    properties: sanitizeAnalyticsProperties(result.properties),
  };
  if (result.$set) {
    sanitized.$set = sanitizeAnalyticsProperties(result.$set);
  }
  if (result.$set_once) {
    sanitized.$set_once = sanitizeAnalyticsProperties(result.$set_once);
  }

  return sanitized;
}

export function postHogEndpointConfig(apiHost: string) {
  return {
    api_host: apiHost,
    ui_host: POSTHOG_UI_HOST,
  } as const;
}

async function loadAnalytics(): Promise<PostHog | null> {
  if (getAnalyticsConsent() !== "granted" || !analyticsIdentityReady) {
    return null;
  }
  if (analyticsClient) {
    if (!analyticsCapturing) {
      resetAndResumeAnalytics(analyticsClient, true);
    }
    return analyticsClient;
  }
  if (
    analyticsDisabled ||
    typeof window === "undefined" ||
    !env.VITE_POSTHOG_PROJECT_TOKEN
  ) {
    return null;
  }
  if (analyticsLoad) return analyticsLoad;

  analyticsLoad = import("posthog-js/dist/module.slim")
    .then(({ default: posthog }) => {
      posthog.init(env.VITE_POSTHOG_PROJECT_TOKEN!, {
        ...postHogEndpointConfig(env.VITE_POSTHOG_HOST),
        defaults: "2026-08-30",
        advanced_disable_flags: true,
        autocapture: false,
        before_send: sanitizeAnalyticsCapture,
        capture_dead_clicks: false,
        capture_exceptions: false,
        capture_pageleave: false,
        capture_pageview: false,
        disable_capture_url_hashes: true,
        disable_external_dependency_loading: true,
        disable_session_recording: true,
        disable_surveys: true,
        enable_heatmaps: false,
        mask_personal_data_properties: true,
        custom_personal_data_properties: ["error", "q", "query", "redirect", "token"],
        opt_out_capturing_by_default: true,
        opt_out_capturing_persistence_type: "localStorage",
        persistence: "localStorage",
        person_profiles: "identified_only",
        respect_dnt: true,
      });
      analyticsClient = posthog;
      if (getAnalyticsConsent() !== "granted" || !analyticsIdentityReady) {
        clearAndDisableAnalytics(posthog);
        return null;
      }
      posthog.opt_in_capturing({ captureEventName: false });
      analyticsCapturing = true;
      return analyticsClient;
    })
    .catch(() => {
      analyticsDisabled = true;
      return null;
    });

  return analyticsLoad;
}

function withAnalytics(action: (client: PostHog) => void): void {
  if (getAnalyticsConsent() !== "granted" || !analyticsIdentityReady) return;

  const run = (client: PostHog | null) => {
    if (
      !client ||
      getAnalyticsConsent() !== "granted" ||
      !analyticsIdentityReady
    ) {
      return;
    }
    try {
      resumeAnalyticsThenRun(client, analyticsCapturing, action);
    } catch {
      // Analytics is observational and must never interrupt the product flow.
    }
  };

  if (analyticsClient) {
    run(analyticsClient);
  } else {
    void loadAnalytics().then(run);
  }
}

export function suspendAnalyticsIdentity(): void {
  analyticsIdentityReady = false;
}

export function disableAnalytics(): void {
  analyticsIdentityReady = false;
  analyticsCapturing = false;
  persistBrowserPostHogConsent("denied");
  const disable = (client: PostHog | null) => {
    if (!client) return;
    applyDeferredAnalyticsDisable(getAnalyticsConsent(), () => {
      try {
        clearAndDisableAnalytics(client);
      } catch {
        // Consent state remains denied even if third-party cleanup fails.
      } finally {
        persistBrowserPostHogConsent("denied");
      }
    });
  };

  if (analyticsClient) disable(analyticsClient);
  else if (analyticsLoad) void analyticsLoad.then(disable);
}

export function setAnalyticsConsentDecision(
  decision: AnalyticsConsentDecision,
): AnalyticsConsentDecision {
  return commitAnalyticsConsent(decision, (effectiveDecision) => {
    if (effectiveDecision === "denied") {
      disableAnalytics();
    } else {
      persistBrowserPostHogConsent("granted");
    }
  });
}

export function applyDeferredAnalyticsDisable(
  consent: AnalyticsConsent,
  disable: () => void,
): void {
  if (consent !== "granted") disable();
}

export function resumeAnalyticsThenRun<
  Client extends AnalyticsIdentityClient,
>(
  client: Client,
  isCapturing: boolean,
  action: (client: Client) => void,
): void {
  if (!isCapturing) resetAndResumeAnalytics(client, true);
  action(client);
}

export function captureAnalytics<EventName extends AnalyticsEventName>(
  event: EventName,
  properties: AnalyticsEventMap[EventName],
  options?: CaptureOptions,
): void {
  withAnalytics((client) => client.capture(event, properties, options));
}

export function analyticsIdentityAction(
  currentUserId: unknown,
  nextUserId: string | undefined,
): AnalyticsIdentityAction {
  const current =
    typeof currentUserId === "string" && currentUserId.length > 0
      ? currentUserId
      : undefined;
  if (nextUserId) {
    if (current === nextUserId) return "none";
    return current ? "reset_and_identify" : "identify";
  }
  return current ? "reset" : "none";
}

export function currentAnalyticsUserId(
  client: AnalyticsIdentityReader,
): string | undefined {
  if (client.get_property("$user_state") !== "identified") return undefined;
  const distinctId = client.get_distinct_id();
  return typeof distinctId === "string" && distinctId.length > 0
    ? distinctId
    : undefined;
}

export function applyAnalyticsIdentityAction(
  client: AnalyticsIdentityClient,
  action: AnalyticsIdentityAction,
  userId: string | undefined,
): void {
  if (action === "reset" || action === "reset_and_identify") {
    resetAndResumeAnalytics(client);
  }
  if ((action === "identify" || action === "reset_and_identify") && userId) {
    client.identify(userId);
  }
}

type AnalyticsPageviewClient = AnalyticsIdentityClient &
  AnalyticsIdentityReader &
  Pick<PostHog, "capture">;

export function applyAnalyticsIdentityAndCapturePageview(
  client: AnalyticsPageviewClient,
  userId: string | undefined,
): void {
  const action = analyticsIdentityAction(currentAnalyticsUserId(client), userId);
  applyAnalyticsIdentityAction(client, action, userId);
  client.capture("$pageview");
}

export function captureAnalyticsPageview(userId: string | undefined): void {
  analyticsIdentityReady = true;
  withAnalytics((client) =>
    applyAnalyticsIdentityAndCapturePageview(client, userId),
  );
}

export function resetAnalyticsIdentity(): void {
  analyticsIdentityReady = true;
  withAnalytics((client) =>
    applyAnalyticsIdentityAction(client, "reset", undefined),
  );
}
