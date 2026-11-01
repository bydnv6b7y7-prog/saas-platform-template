import { describe, expect, test } from "bun:test";

import { usageWindow } from "./usage";

describe("usage windows", () => {
  test("uses transparent UTC-aligned daily resets", () => {
    const now = Date.parse("2026-08-29T15:42:00.000Z");
    const window = usageWindow(24 * 60 * 60 * 1_000, now);

    expect(window.bucketStartedAt.toISOString()).toBe("2026-08-29T00:00:00.000Z");
    expect(window.resetAt.toISOString()).toBe("2026-08-30T00:00:00.000Z");
    expect(window.windowSeconds).toBe(86_400);
  });
});
