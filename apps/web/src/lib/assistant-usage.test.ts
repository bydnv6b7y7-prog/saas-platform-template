import { describe, expect, test } from "bun:test";

import { assistantQuotaMessage } from "./assistant-usage";

describe("assistant quota presentation", () => {
  test("names requests instead of ambiguous chat messages", () => {
    expect(
      assistantQuotaMessage({
        plan: "free",
        accessSource: "free",
        historyEnabled: true,
    configured: true,
        limits: { per5Minutes: 5, perDay: 5 },
        daily: {
          used: 4,
          remaining: 1,
          resetAt: "2026-08-30T00:00:00.000Z",
        },
      }),
    ).toBe("Free · 1 of 5 requests left today");
  });

  test("identifies administrator access without calling it a subscription", () => {
    expect(
      assistantQuotaMessage({
        plan: "pro",
        accessSource: "admin",
        historyEnabled: true,
    configured: true,
        limits: { per5Minutes: 10, perDay: 100 },
        daily: {
          used: 2,
          remaining: 98,
          resetAt: "2026-08-30T00:00:00.000Z",
        },
      }),
    ).toBe("Admin · 98 of 100 requests left today");
  });
});
