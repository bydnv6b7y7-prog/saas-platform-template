import { describe, expect, test } from "bun:test";

import { exitCode, groupState, render, type Check } from "./doctor";

describe("doctor", () => {
  test("classifies all-or-none variable groups", () => {
    expect(groupState({}, ["A", "B"])).toEqual({ state: "off", missing: ["A", "B"] });
    expect(groupState({ A: "1", B: " " }, ["A", "B"])).toEqual({ state: "partial", missing: ["B"] });
    expect(groupState({ A: "1", B: "2" }, ["A", "B"])).toEqual({ state: "on", missing: [] });
  });

  test("fails only on failures and shows next steps for anything not ok", () => {
    const checks: Check[] = [
      { section: "S", name: "a", status: "ok", detail: "fine", next: "hidden" },
      { section: "S", name: "b", status: "warn", detail: "meh", next: "do b" },
      { section: "T", name: "c", status: "off", detail: "off" },
    ];
    expect(exitCode(checks)).toBe(0);
    expect(exitCode([...checks, { section: "T", name: "d", status: "fail", detail: "bad" }])).toBe(1);
    const text = render(checks);
    expect(text).toContain("→ do b");
    expect(text).not.toContain("hidden");
    expect(text).toContain("Ready (1 warning(s)).");
  });
});
