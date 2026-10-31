import { expect, test } from "bun:test";
import { appStoreMetrics } from "../app-store-metrics";

test("App Store metrics expose bounded counters and persisted recovery lag", async () => {
  const values = await appStoreMetrics({ async metrics() { return {
    counters: { "SyncFailed:SUBSCRIPTION_OWNERSHIP_CONFLICT": 1, "bad\"label": 99 },
    pendingNotifications: 2, oldestNotificationAgeSeconds: 10, deadNotifications: 1,
    pendingTokens: 1, blockedTokens: 0, staleSubscriptions: 3,
    historyCoverageGaps: 1, unfinishedHistoryScopes: 1, historyLagSeconds: 600,
  }; } });
  expect(values).toContain("app_store_history_lag_seconds 600");
  expect(values).toContain('app_store_events_total{event="SyncFailed",code="SUBSCRIPTION_OWNERSHIP_CONFLICT"} 1');
  expect(values.join("\n")).not.toContain("bad");
});
test("disabled integration and metric storage failure do not fail the shared endpoint", async () => {
  expect(await appStoreMetrics(null)).toContain("app_store_configured 0");
  const values = await appStoreMetrics({ async metrics() { throw new Error("sensitive storage detail"); } });
  expect(values).toContain("app_store_metrics_available 0");
  expect(values.join("\n")).not.toContain("sensitive");
});
