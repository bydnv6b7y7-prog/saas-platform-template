import { describe, expect, it } from "bun:test";

import { createAdminAccess } from "./admin";

describe("admin access", () => {
  it("normalizes bootstrap ids and requires an exact match", () => {
    const access = createAdminAccess(" user-1, user-2 ,,user-1 ");

    expect(access.allows({ id: "user-1" })).toBe(true);
    expect(access.allows({ id: "user" })).toBe(false);
    expect(access.allows({ id: "USER-1" })).toBe(false);
  });

  it("matches Better Auth's exact comma-separated admin role semantics", () => {
    const access = createAdminAccess("");

    expect(access.allows({ id: "user-1", role: "admin" })).toBe(true);
    expect(access.allows({ id: "user-1", role: "user,admin" })).toBe(true);
    expect(access.allows({ id: "user-1", role: "user, admin" })).toBe(false);
    expect(access.allows({ id: "user-1", role: "administrator" })).toBe(false);
  });

  it("creates the configured Better Auth Admin Plugin", () => {
    expect(createAdminAccess("user-1").betterAuthPlugin().id).toBe("admin");
  });
});
