import { describe, expect, test } from "bun:test";
import {
  POSTHOG_BROWSER_PROXY_HOST,
  POSTHOG_UI_HOST,
} from "@northwind/env/posthog";
import {
  applyAnalyticsIdentityAction,
  applyAnalyticsIdentityAndCapturePageview,
  analyticsIdentityAction,
  currentAnalyticsUserId,
  persistPostHogConsent,
  postHogEndpointConfig,
  sanitizeAnalyticsCapture,
  sanitizeAnalyticsUrl,
} from "./analytics";
import { ANALYTICS_CONSENT_STORAGE_KEY } from "./analytics-consent";

const PROJECT_TOKEN = ["phc", "test-project-token-not-a-secret"].join("_");
const POSTHOG_PERSISTENCE_KEY = `ph_${PROJECT_TOKEN}_posthog`;
const POSTHOG_CONSENT_KEY = `__ph_opt_in_out_${PROJECT_TOKEN}`;

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe("PostHog endpoints", () => {
  test("sends browser events through the Worker while keeping the US project UI", () => {
    expect(postHogEndpointConfig(POSTHOG_BROWSER_PROXY_HOST)).toEqual({
      api_host: "https://ingest.northwind.dev",
      ui_host: POSTHOG_UI_HOST,
    });
  });
});

describe("PostHog browser persistence", () => {
  test("removes only this project's identity when consent is denied before the SDK loads", () => {
    const storage = new MemoryStorage();
    const projectKeys = [
      POSTHOG_PERSISTENCE_KEY,
      `${POSTHOG_PERSISTENCE_KEY}__flags`,
      `${POSTHOG_PERSISTENCE_KEY}__surveys`,
      `${POSTHOG_PERSISTENCE_KEY}_cookie_identity_change_pending`,
      `ph_${PROJECT_TOKEN}_primary_window_exists`,
      `ph_${PROJECT_TOKEN}_session_registered_properties`,
      `ph_${PROJECT_TOKEN}_window_id`,
      `ph_conv_${PROJECT_TOKEN}`,
    ];
    for (const key of projectKeys) storage.setItem(key, "private-identity");
    storage.setItem(ANALYTICS_CONSENT_STORAGE_KEY, "denied");
    storage.setItem("ph_other-project_posthog", "other-identity");
    storage.setItem("app.preference", "keep");

    persistPostHogConsent(storage, PROJECT_TOKEN, "denied");
    persistPostHogConsent(storage, PROJECT_TOKEN, "denied");

    for (const key of projectKeys) expect(storage.getItem(key)).toBeNull();
    expect(storage.getItem(POSTHOG_CONSENT_KEY)).toBe("0");
    expect(storage.getItem(ANALYTICS_CONSENT_STORAGE_KEY)).toBe("denied");
    expect(storage.getItem("ph_other-project_posthog")).toBe("other-identity");
    expect(storage.getItem("app.preference")).toBe("keep");
  });

  test("records re-consent without recreating the withdrawn identity", () => {
    const storage = new MemoryStorage();
    storage.setItem(POSTHOG_PERSISTENCE_KEY, "old-identity");

    persistPostHogConsent(storage, PROJECT_TOKEN, "denied");
    persistPostHogConsent(storage, PROJECT_TOKEN, "granted");

    expect(storage.getItem(POSTHOG_PERSISTENCE_KEY)).toBeNull();
    expect(storage.getItem(POSTHOG_CONSENT_KEY)).toBe("1");
  });
});

describe("analytics URL sanitization", () => {
  test("removes every query value while campaign attribution remains separate", () => {
    expect(
      sanitizeAnalyticsUrl(
        "https://app.northwind.dev/rankings?genre=6014&chart=top-free&utm_source=launch&q=private",
      ),
    ).toBe("https://app.northwind.dev/rankings");
  });

  test("redacts share tokens and strips referrer query strings", () => {
    expect(sanitizeAnalyticsUrl("https://app.northwind.dev/s/secret-token?utm_source=email")).toBe(
      "https://app.northwind.dev/s/redacted",
    );
    expect(sanitizeAnalyticsUrl("https://example.com/article?email=person@example.com")).toBe(
      "https://example.com/article",
    );
  });

  test("preserves direct attribution and removes URL credentials", () => {
    expect(sanitizeAnalyticsUrl("$direct")).toBe("$direct");
    expect(sanitizeAnalyticsUrl("https://user:password@example.com/path?private=true")).toBe(
      "https://example.com/path",
    );
  });

  test("fails closed for malformed values", () => {
    expect(sanitizeAnalyticsUrl("http://[invalid")).toBe("redacted");
    expect(sanitizeAnalyticsUrl("javascript:private-value")).toBe("redacted");
  });

  test("sanitizes URL properties without disabling browser GeoIP enrichment", () => {
    const sanitized = sanitizeAnalyticsCapture({
      uuid: "00000000-0000-4000-8000-000000000000",
      event: "$pageview",
      properties: {
        $current_url: "https://app.northwind.dev/rankings?q=private#section",
        $initial_person_info: {
          r: "https://search.example/results?q=private#section",
          u: "https://app.northwind.dev/s/secret-token?utm_source=launch#private",
        },
        $session_entry_referrer: "https://search.example/?q=private",
        ph_keyword: "private search",
        utm_source: "launch",
      },
      $set: {
        $initial_pathname: "/s/secret-token?utm_source=email",
      },
      $set_once: {
        $initial_current_url: "https://app.northwind.dev/s/secret-token#private",
        $initial_ph_keyword: "private search",
      },
    });

    expect(sanitized?.properties).toEqual({
      $current_url: "https://app.northwind.dev/rankings",
      $initial_person_info: {
        r: "https://search.example/results",
        u: "https://app.northwind.dev/s/redacted",
      },
      $session_entry_referrer: "https://search.example/",
      utm_source: "launch",
    });
    expect(sanitized?.$set).toEqual({ $initial_pathname: "/s/redacted" });
    expect(sanitized?.$set_once).toEqual({
      $initial_current_url: "https://app.northwind.dev/s/redacted",
    });
  });
});

describe("analytics identity transitions", () => {
  test("reads an account identity only when PostHog marks it identified", () => {
    expect(
      currentAnalyticsUserId({
        get_distinct_id: () => "anonymous-device",
        get_property: () => "anonymous",
      }),
    ).toBeUndefined();
    expect(
      currentAnalyticsUserId({
        get_distinct_id: () => "user-1",
        get_property: () => "identified",
      }),
    ).toBe("user-1");
  });

  test("identifies anonymous sessions without resetting their attribution history", () => {
    expect(analyticsIdentityAction(undefined, "user-1")).toBe("identify");
    expect(analyticsIdentityAction("user-1", "user-1")).toBe("none");
  });

  test("resets before changing accounts and after logout", () => {
    expect(analyticsIdentityAction("user-1", "user-2")).toBe("reset_and_identify");
    expect(analyticsIdentityAction("user-1", undefined)).toBe("reset");
  });

  test("restores capture after a reset before identifying the next account", () => {
    const calls: string[] = [];
    const client = {
      identify(userId: string) {
        calls.push(`identify:${userId}`);
      },
      opt_in_capturing(options?: { captureEventName?: unknown }) {
        calls.push(`opt_in:${String(options?.captureEventName)}`);
      },
      reset() {
        calls.push("reset");
      },
    };

    applyAnalyticsIdentityAction(client, "reset_and_identify", "user-2");
    expect(calls).toEqual(["reset", "opt_in:false", "identify:user-2"]);
  });

  test("identifies before the first pageview in one operation", () => {
    const calls: string[] = [];
    let distinctId = "anonymous-device";
    let userState = "anonymous";
    const client = {
      capture(event: string) {
        calls.push(`capture:${event}`);
        return undefined;
      },
      get_distinct_id: () => distinctId,
      get_property: (key: string) =>
        key === "$user_state" ? userState : undefined,
      identify(userId: string) {
        calls.push(`identify:${userId}`);
        distinctId = userId;
        userState = "identified";
      },
      opt_in_capturing(options?: { captureEventName?: unknown }) {
        calls.push(`opt_in:${String(options?.captureEventName)}`);
      },
      reset() {
        calls.push("reset");
        distinctId = "new-anonymous-device";
        userState = "anonymous";
      },
    };

    applyAnalyticsIdentityAndCapturePageview(client, "user-1");

    expect(calls).toEqual(["identify:user-1", "capture:$pageview"]);
  });

  test("resets a prior account before identifying and capturing for the next one", () => {
    const calls: string[] = [];
    let distinctId = "user-1";
    let userState = "identified";
    const client = {
      capture(event: string) {
        calls.push(`capture:${event}`);
        return undefined;
      },
      get_distinct_id: () => distinctId,
      get_property: (key: string) =>
        key === "$user_state" ? userState : undefined,
      identify(userId: string) {
        calls.push(`identify:${userId}`);
        distinctId = userId;
        userState = "identified";
      },
      opt_in_capturing(options?: { captureEventName?: unknown }) {
        calls.push(`opt_in:${String(options?.captureEventName)}`);
      },
      reset() {
        calls.push("reset");
        distinctId = "new-anonymous-device";
        userState = "anonymous";
      },
    };

    applyAnalyticsIdentityAndCapturePageview(client, "user-2");

    expect(calls).toEqual([
      "reset",
      "opt_in:false",
      "identify:user-2",
      "capture:$pageview",
    ]);
  });
});
