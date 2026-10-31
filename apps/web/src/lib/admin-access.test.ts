import { describe, expect, it } from "bun:test";

import { adminAccessQueryOptions } from "./admin-access";

describe("admin access query", () => {
  it("isolates cached permission checks by authenticated user", () => {
    expect([...adminAccessQueryOptions("admin-1").queryKey]).toEqual([
      "better-auth",
      "admin",
      "access",
      "admin-1",
    ]);
  });
});
