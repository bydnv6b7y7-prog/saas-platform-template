import { describe, expect, it } from "bun:test";

import { formatEnUsNumber, formatUtcDate, formatUtcDateTime } from "./format";

describe("SSR-stable presentation formatting", () => {
  it("formats UTC dates without runtime-specific Intl punctuation", () => {
    const value = "2026-08-23T05:51:00.000Z";
    expect(formatUtcDate(value)).toBe("Aug 23, 2026");
    expect(formatUtcDate(value, { year: false })).toBe("Aug 23");
    expect(formatUtcDateTime(value)).toBe("Aug 23, 2026, 05:51 UTC");
  });

  it("pins visible numbers to en-US grouping", () => {
    expect(formatEnUsNumber(12_345)).toBe("12,345");
  });
});
