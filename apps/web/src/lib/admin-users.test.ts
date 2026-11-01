import { describe, expect, it } from "bun:test";

import {
  adminUsersQueryOptions,
  createAdminUserSearch,
  getAdminUserChanges,
  updateAdminUserEmail,
} from "./admin-users";

describe("admin users helpers", () => {
  it("normalizes submitted search text and removes empty searches", () => {
    expect(createAdminUserSearch("name", "  Ada   Lovelace  ")).toEqual({
      field: "name",
      value: "Ada Lovelace",
    });
    expect(createAdminUserSearch("email", "  ")).toBeNull();
  });

  it("owns cache isolation and page normalization", () => {
    expect([
      ...adminUsersQueryOptions({
        adminUserId: "admin-1",
        page: -2,
        search: { field: "email", value: " admin@example.com " },
      }).queryKey,
    ]).toEqual([
      "better-auth",
      "admin",
      "users",
      "admin-1",
      { page: 0, search: { field: "email", value: "admin@example.com" } },
    ]);
  });

  it("updates only changed fields and preserves roles outside the editor choices", () => {
    const initial = {
      name: "Ada",
      email: "ada@example.com",
      role: "user,admin",
      emailVerified: true,
    };
    expect(
      getAdminUserChanges(initial, {
        ...initial,
        name: " Ada ",
        email: " ADA@example.com ",
      }),
    ).toEqual({});
    expect(getAdminUserChanges(initial, { ...initial, name: "Grace" })).toEqual(
      { name: "Grace" },
    );
    expect(
      getAdminUserChanges(initial, {
        ...initial,
        email: "new@example.com",
        emailVerified: false,
      }),
    ).toEqual({ email: "new@example.com", emailVerified: false });
    expect(
      getAdminUserChanges(initial, {
        ...initial,
        email: "new@example.com",
        emailVerified: true,
      }),
    ).toEqual({ email: "new@example.com", emailVerified: true });
    expect(getAdminUserChanges(initial, { ...initial, role: "user" })).toEqual({
      role: "user",
    });
  });

  it("preserves verification for cosmetic email edits and clears it for a new mailbox", () => {
    const user = {
      name: "Ada",
      email: "ada@example.com",
      role: "user",
      emailVerified: true,
    };
    const cosmetic = updateAdminUserEmail(user, " ADA@example.com ");
    expect(cosmetic.emailVerified).toBe(true);
    expect(getAdminUserChanges(user, cosmetic)).toEqual({});
    expect(updateAdminUserEmail(user, "grace@example.com").emailVerified).toBe(
      false,
    );
    expect(
      updateAdminUserEmail({ ...user, emailVerified: false }, "ADA@example.com")
        .emailVerified,
    ).toBe(false);
  });
});
