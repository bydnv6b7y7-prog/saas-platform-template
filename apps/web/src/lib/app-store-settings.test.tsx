import { describe, expect, it } from "bun:test";
import type { AppStoreAdminOverview } from "@northwind/api/app-store-admin";
import type { AppRouter } from "@northwind/product/router";
import { APPLE_APPLICATION } from "@northwind/env/apple-application";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { renderToStaticMarkup } from "react-dom/server";

import { AppStoreDiagnostics, AppStoreHistory, AppStoreTestNotification } from "@/components/admin/app-store-settings";
import { TRPCProvider } from "@/utils/trpc";
import {
  appStoreTestStatusMessage,
  appStoreTestStorageKey,
  appStoreTestEnvironmentChoices,
  canConfirmAppStoreTestWasNotSent,
  latestAppStoreTestAttempt,
  nextAppStoreTestRequest,
  parseAppStoreTestAttempt,
  type AppStoreTestAttempt,
} from "./app-store-settings";

const requestId = "e03463f0-3a48-4dd4-9876-94e543d65258";
const updatedAt = "2026-09-13T05:15:00.000Z";
const pending: AppStoreTestAttempt = { requestId, environment: "Sandbox", status: "unconfirmed", updatedAt };

function renderTestNotification(allowedEnvironments: AppStoreAdminOverview["allowedEnvironments"]) {
  const queryClient = new QueryClient();
  const trpcClient = createTRPCClient<AppRouter>({ links: [httpBatchLink({ url: "http://127.0.0.1:3000/trpc", fetch: () => { throw new Error("Rendering must not send a request"); } })] });
  const data: AppStoreAdminOverview = {
    application: APPLE_APPLICATION, enabled: true, configured: true, credentials: [], configurationError: null,
    allowedEnvironments, notificationUrl: null, maintenance: { reverifyIntervalSeconds: 900, reconcileIntervalSeconds: 21600 },
    diagnostics: { observedAt: updatedAt, environments: [] }, notifications: { available: true, items: [] }, audit: { available: true, items: [] },
  };
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}><TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
      <AppStoreTestNotification data={data} actorId="admin-one" stale={false} />
    </TRPCProvider></QueryClientProvider>,
  );
}

describe("App Store advanced diagnostics", () => {
  it("starts collapsed and uses the sole Apple environment without a selector", () => {
    const markup = renderTestNotification(["Production"]);
    expect(markup).toContain("Advanced diagnostics");
    expect(markup).not.toMatch(/<details[^>]*\sopen[\s=>]/);
    expect(markup).toContain("Apple environment · Production");
    expect(markup).not.toContain('type="radio"');
    expect(markup).not.toContain("Choose an environment first");
    expect(markup).toContain("does not create a purchase or subscription");
  });

  it("asks for an Apple environment only when more than one is available", () => {
    const markup = renderTestNotification(["Production", "Sandbox"]);
    expect(markup).toContain("Apple environment</legend>");
    expect(markup.match(/type="radio"/g)?.length).toBe(2);
    expect(markup).toContain("Choose an environment first");
    expect(markup).not.toContain("Test environment");
  });

  it("automatically selects a sole saved environment for status recovery only", () => {
    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
    const savedKey = appStoreTestStorageKey(APPLE_APPLICATION.bundleId, "admin-one", "Sandbox");
    Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { getItem: (key: string) => key === savedKey ? JSON.stringify(pending) : null } });
    try {
      const markup = renderTestNotification([]);
      expect(markup).toContain("Apple environment · Sandbox · Status only");
      expect(markup).toContain("Check request status");
      expect(markup).not.toContain('type="radio"');
      expect(markup).not.toContain("Choose an environment first");
      expect(markup).not.toContain("Send test notification</button>");
    } finally {
      if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor); else Reflect.deleteProperty(globalThis, "window");
      if (storageDescriptor) Object.defineProperty(globalThis, "sessionStorage", storageDescriptor); else Reflect.deleteProperty(globalThis, "sessionStorage");
    }
  });
});

describe("App Store test request identity", () => {
  it("retains the same ID for uncertain retries without allocating another request", () => {
    for (const status of ["unconfirmed", "not_sent", "pending", "unknown"] as const) {
      const input = nextAppStoreTestRequest({ ...pending, status }, "Sandbox", () => { throw new Error("A retry must not allocate another ID"); });
      expect(input).toEqual({ environment: "Sandbox", requestId });
    }
  });

  it("allocates a new ID only for a new explicit request or a different environment", () => {
    for (const previous of [undefined, { ...pending, status: "accepted" as const }, { ...pending, status: "failed" as const }]) {
      expect(nextAppStoreTestRequest(previous, "Sandbox", () => "new-id").requestId).toBe("new-id");
    }
    expect(nextAppStoreTestRequest(pending, "Production", () => "production-id")).toEqual({ environment: "Production", requestId: "production-id" });
  });

  it("isolates persisted attempts by application, administrator, and environment", () => {
    const keys = [
      appStoreTestStorageKey("app.one", "admin:one", "Sandbox"),
      appStoreTestStorageKey("app.one", "admin:two", "Sandbox"),
      appStoreTestStorageKey("app.two", "admin:one", "Sandbox"),
      appStoreTestStorageKey("app.one", "admin:one", "Production"),
    ];
    expect(new Set(keys).size).toBe(keys.length);
    expect(parseAppStoreTestAttempt(JSON.stringify(pending), "Sandbox")).toEqual(pending);
    expect(parseAppStoreTestAttempt(JSON.stringify(pending), "Production")).toBeNull();
  });

  it("keeps a removed environment available only for its saved request status", () => {
    expect(appStoreTestEnvironmentChoices(["Production"], { Sandbox: pending })).toEqual([
      { environment: "Production", statusOnly: false },
      { environment: "Sandbox", statusOnly: true },
    ]);
    expect(appStoreTestEnvironmentChoices(["Production"], {})).toEqual([{ environment: "Production", statusOnly: false }]);
    expect(appStoreTestEnvironmentChoices([], { Sandbox: pending })).toEqual([{ environment: "Sandbox", statusOnly: true }]);
  });

  it("discards malformed storage without treating it as a completed request", () => {
    for (const value of [null, "invalid", "{}", JSON.stringify({ ...pending, requestId: "not-a-uuid" }), JSON.stringify({ ...pending, status: "delivered" }), JSON.stringify({ ...pending, updatedAt: "not-a-date" })]) {
      expect(parseAppStoreTestAttempt(value, "Sandbox")).toBeNull();
    }
  });

  it("distinguishes Apple acceptance, uncertain outcomes, and received events", () => {
    expect(appStoreTestStatusMessage("accepted")).toContain("Delivery is not confirmed");
    expect(appStoreTestStatusMessage("unknown")).toContain("will not be sent again");
    expect(appStoreTestStatusMessage("pending")).toContain("still being processed");
    expect(appStoreTestStatusMessage("unconfirmed")).toContain("same request ID");
    expect(appStoreTestStatusMessage("not_sent")).toContain("before a request was sent to Apple");
  });

  it("does not replace a confirmed outcome with stale cached history", () => {
    const saved = { ...pending, status: "accepted" as const };
    const earlier = { ...pending, status: "pending" as const, actorId: "admin", createdAt: updatedAt, updatedAt: "2026-09-13T05:14:00.000Z", errorCode: null };
    expect(latestAppStoreTestAttempt(saved, earlier)?.status).toBe("accepted");
    expect(latestAppStoreTestAttempt(saved, { ...earlier, updatedAt })?.status).toBe("accepted");
    expect(latestAppStoreTestAttempt({ ...pending, updatedAt: "2027-01-01T00:00:00.000Z" }, { ...earlier, status: "accepted" })?.status).toBe("accepted");
  });

  it("retains uncertainty when a lost-response request is later rejected on retry", () => {
    // Apple may have received the first call before its response was lost. The server can
    // subsequently disable billing, remove an environment, or reject an expired session.
    for (const code of ["PRECONDITION_FAILED", "BAD_REQUEST", "UNAUTHORIZED", "FORBIDDEN", "TOO_MANY_REQUESTS"]) {
      expect(canConfirmAppStoreTestWasNotSent(pending, code)).toBe(false);
      expect(nextAppStoreTestRequest(pending, "Sandbox", () => { throw new Error("Keep the uncertain request ID"); }).requestId).toBe(requestId);
    }
  });

  it("confirms a pre-send rejection only for a first attempt or an already unsent attempt", () => {
    const unsent = { ...pending, status: "not_sent" as const };
    for (const code of ["PRECONDITION_FAILED", "BAD_REQUEST", "UNAUTHORIZED", "FORBIDDEN", "TOO_MANY_REQUESTS"]) {
      expect(canConfirmAppStoreTestWasNotSent(undefined, code)).toBe(true);
      expect(canConfirmAppStoreTestWasNotSent(unsent, code)).toBe(true);
    }
    for (const code of [undefined, "INTERNAL_SERVER_ERROR", "TIMEOUT"]) {
      expect(canConfirmAppStoreTestWasNotSent(undefined, code)).toBe(false);
      expect(canConfirmAppStoreTestWasNotSent(unsent, code)).toBe(false);
    }
  });
});

describe("App Store diagnostic state", () => {
  const emptyMetrics = { pendingNotifications: 0, oldestNotificationAgeSeconds: 0, deadNotifications: 0, pendingTokens: 0, blockedTokens: 0, staleSubscriptions: 0, historyCoverageGaps: 0, unfinishedHistoryScopes: 0, historyLagSeconds: 0 };

  it("renders an unavailable environment without fabricating metric zeros", () => {
    const diagnostics: AppStoreAdminOverview["diagnostics"] = {
      observedAt: updatedAt,
      environments: [{ environment: "Production", processingEnabled: false, available: false, metrics: null }],
    };
    const markup = renderToStaticMarkup(<AppStoreDiagnostics diagnostics={diagnostics} />);
    expect(markup).toContain("Diagnostics unavailable");
    expect(markup).toContain("Processing disabled");
    expect(markup).toContain("Sep 13, 2026, 05:15 UTC");
    expect(markup).not.toContain("Queued notifications");
  });

  it("labels disabled observations and makes no health claim from an empty database", () => {
    const diagnostics: AppStoreAdminOverview["diagnostics"] = {
      observedAt: updatedAt,
      environments: [{ environment: "Sandbox", processingEnabled: false, available: true, metrics: emptyMetrics }],
    };
    const markup = renderToStaticMarkup(<AppStoreDiagnostics diagnostics={diagnostics} />);
    expect(markup).toContain("Stored records are shown");
    expect(markup).toContain("Empty queues do not confirm notification delivery");
    expect(markup).toContain("No lag recorded");
    expect(markup).not.toContain("Healthy");
  });

  it("separates unavailable history from an observed empty inbox and accepted test requests", () => {
    const unavailable = renderToStaticMarkup(<AppStoreHistory notifications={{ available: false, items: [] }} audit={{ available: false, items: [] }} />);
    expect(unavailable).toContain("Notification history is unavailable");
    expect(unavailable).not.toContain("No notifications have been recorded");
    const recorded = renderToStaticMarkup(<AppStoreHistory notifications={{ available: true, items: [] }} audit={{ available: true, items: [{ ...pending, status: "accepted", actorId: "admin-one", createdAt: updatedAt, errorCode: null }] }} />);
    expect(recorded).toContain("No notifications have been recorded");
    expect(recorded).toContain("Accepted by Apple");
    expect(recorded).toContain("does not confirm delivery");
    expect(recorded).not.toContain("Delivered");
  });
});
