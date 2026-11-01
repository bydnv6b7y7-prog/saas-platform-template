import { describe, expect, test } from "bun:test";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";

import { createAdminAccess } from "./admin";
import { createEmailVerificationOptions } from "./email-verification";

const baseURL = "http://localhost:4099";
const password = "FixtureOnlyPassword123!";
const newUser = {
  name: "New reader",
  email: "new@example.invalid",
  password,
  role: "user",
  data: { emailVerified: true },
};

function fixture(bootstrap = false) {
  const database: Record<string, any[]> = {
    user: [],
    session: [],
    account: [],
    verification: [],
  };
  const verification = createEmailVerificationOptions(async () => {});
  const auth = betterAuth({
    ...verification,
    database: memoryAdapter(database),
    baseURL,
    secret: "isolated-admin-test-secret-with-more-than-32-characters",
    plugins: [
      createAdminAccess(bootstrap ? "test-admin-id" : "").betterAuthPlugin(),
      ...verification.plugins,
    ],
    advanced: {
      disableOriginCheck: false,
      disableCSRFCheck: false,
      database: {
        generateId: ({ model }) =>
          model === "user" && !database.user!.length
            ? "test-admin-id"
            : crypto.randomUUID(),
      },
    },
    rateLimit: { enabled: false },
    logger: { disabled: true },
  });
  const call = (
    path: string,
    body?: object,
    cookie?: string,
    origin = baseURL,
  ) =>
    auth.handler(
      new Request(`${baseURL}/api/auth/${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          "Content-Type": "application/json",
          Origin: origin,
          ...(cookie ? { Cookie: cookie } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
  const signIn = (email: string) => call("sign-in/email", { email, password });
  const seed = async (role = "admin", email = "admin@example.invalid") => {
    expect(
      (
        await call("sign-up/email", {
          name: "Existing account",
          email,
          password,
        })
      ).status,
    ).toBe(200);
    const user = database.user!.find((user) => user.email === email)!;
    user.role = role;
    user.emailVerified = true;
    const response = await signIn(email);
    expect(response.status).toBe(200);
    return { user, cookie: sessionCookie(response) };
  };
  return { database, call, seed, signIn };
}

function sessionCookie(response: Response) {
  const cookie = response.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith("better-auth.session_token="))
    ?.split(";")[0];
  expect(cookie).toBeTruthy();
  return cookie!;
}

describe("admin user management through Better Auth", () => {
  test("creates a usable credential account, updates it, and deletes its accounts and sessions", async () => {
    const f = fixture();
    const actor = await f.seed();
    const created = await f.call(
      "admin/create-user",
      { ...newUser, name: "  New reader  ", email: "  NEW@example.invalid  " },
      actor.cookie,
    );
    expect(created.status).toBe(200);
    const { user } = (await created.json()) as { user: { id: string } };
    expect(f.database.user!.find((row) => row.id === user.id)).toMatchObject({
      name: "New reader",
      email: newUser.email,
      role: "user",
      emailVerified: true,
    });
    expect(
      f.database.account!.find((row) => row.userId === user.id)?.password,
    ).not.toBe(password);
    const login = await f.signIn(newUser.email);
    expect(login.status).toBe(200);
    const cookie = sessionCookie(login);

    const updated = await f.call(
      "admin/update-user",
      { userId: user.id, data: { name: "Updated reader", role: "admin" } },
      actor.cookie,
    );
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      id: user.id,
      name: "Updated reader",
      role: "admin",
    });
    const listed = await f.call(
      "admin/list-users?searchField=name&searchOperator=contains&searchValue=Updated&limit=20&offset=0",
      undefined,
      actor.cookie,
    );
    expect(await listed.json()).toMatchObject({
      total: 1,
      users: [{ id: user.id, name: "Updated reader" }],
    });

    expect(
      (await f.call("admin/remove-user", { userId: user.id }, actor.cookie))
        .status,
    ).toBe(200);
    for (const table of ["user", "account", "session"]) {
      expect(
        f.database[table]!.some((row) =>
          table === "user" ? row.id === user.id : row.userId === user.id,
        ),
      ).toBe(false);
    }
    expect(
      await (await f.call("get-session", undefined, cookie)).json(),
    ).toBeNull();
    expect((await f.signIn(newUser.email)).status).not.toBe(200);
    expect(
      (await f.call("admin/remove-user", { userId: user.id }, actor.cookie))
        .status,
    ).toBe(404);
    expect(f.database.user!.map((row) => row.id)).toEqual([actor.user.id]);
  });

  test("anonymous and ordinary accounts cannot call any user mutation", async () => {
    const f = fixture();
    const reader = await f.seed("user");
    const requests = [
      ["admin/create-user", newUser],
      [
        "admin/update-user",
        { userId: reader.user.id, data: { role: "admin" } },
      ],
      ["admin/set-role", { userId: reader.user.id, role: "admin" }],
      ["admin/remove-user", { userId: reader.user.id }],
    ] as const;
    for (const [path, body] of requests) {
      expect((await f.call(path, body)).status).toBe(401);
      expect((await f.call(path, body, reader.cookie)).status).toBe(403);
    }
    expect(f.database.user).toHaveLength(1);
    expect(reader.user.role).toBe("user");
  });

  test("bootstrap administrators retain the same management rights", async () => {
    const f = fixture(true);
    const actor = await f.seed("user");
    const created = await f.call("admin/create-user", newUser, actor.cookie);
    expect(created.status).toBe(200);
    const { user } = (await created.json()) as { user: { id: string } };
    expect(
      (
        await f.call(
          "admin/update-user",
          { userId: user.id, data: { name: "Bootstrap edit" } },
          actor.cookie,
        )
      ).status,
    ).toBe(200);
    expect(
      (await f.call("admin/remove-user", { userId: user.id }, actor.cookie))
        .status,
    ).toBe(200);
  });

  test("rejects invalid fields and passwords before creating accounts", async () => {
    const f = fixture();
    const actor = await f.seed();
    for (const invalid of [
      { ...newUser, password: "short" },
      { ...newUser, password: "x".repeat(129) },
      { ...newUser, password: undefined },
      { ...newUser, name: "   " },
      { ...newUser, email: "invalid" },
      { ...newUser, role: "owner" },
      { ...newUser, data: { id: "supplied-id" } },
    ])
      expect(
        (await f.call("admin/create-user", invalid, actor.cookie)).status,
      ).toBe(400);
    expect(f.database.user).toHaveLength(1);
    expect(f.database.account).toHaveLength(1);
    for (const data of [
      { name: " " },
      { role: "owner" },
      { id: "replacement" },
      { password },
      { stripeCustomerId: "customer" },
      {},
    ]) {
      expect(
        (
          await f.call(
            "admin/update-user",
            { userId: actor.user.id, data },
            actor.cookie,
          )
        ).status,
      ).toBe(400);
    }
    expect(
      (
        await f.call(
          "admin/update-user",
          { userId: "", data: { name: "Updated" } },
          actor.cookie,
        )
      ).status,
    ).toBe(400);
  });

  test("duplicate emails leave both accounts unchanged and new emails require fresh verification", async () => {
    const f = fixture();
    const actor = await f.seed();
    const reader = await f.seed("user", "reader@example.invalid");
    expect(
      (
        await f.call(
          "admin/create-user",
          { ...newUser, email: "READER@example.invalid" },
          actor.cookie,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await f.call(
          "admin/update-user",
          {
            userId: reader.user.id,
            data: { email: actor.user.email, name: "Overwritten" },
          },
          actor.cookie,
        )
      ).status,
    ).toBe(400);
    expect(reader.user).toMatchObject({
      name: "Existing account",
      email: "reader@example.invalid",
      emailVerified: true,
    });
    const changed = await f.call(
      "admin/update-user",
      { userId: reader.user.id, data: { email: " NEW@example.invalid " } },
      actor.cookie,
    );
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({
      email: newUser.email,
      emailVerified: false,
    });
    expect((await f.signIn(newUser.email)).status).toBe(403);
    expect(
      (
        await f.call(
          "admin/update-user",
          { userId: reader.user.id, data: { emailVerified: true } },
          actor.cookie,
        )
      ).status,
    ).toBe(200);
    expect((await f.signIn(newUser.email)).status).toBe(200);
    expect(f.database.user).toHaveLength(2);
  });

  test("unverified admin-created users must complete email verification before login", async () => {
    const f = fixture();
    const actor = await f.seed();
    const created = await f.call(
      "admin/create-user",
      { ...newUser, data: { emailVerified: false } },
      actor.cookie,
    );
    expect(created.status).toBe(200);
    expect((await f.signIn(newUser.email)).status).toBe(403);
    expect(f.database.session).toHaveLength(1);
  });

  test("cannot delete oneself or remove one's own admin access through either endpoint", async () => {
    const f = fixture();
    const actor = await f.seed();
    expect(
      (
        await f.call(
          "admin/remove-user",
          { userId: actor.user.id },
          actor.cookie,
        )
      ).status,
    ).toBe(400);
    for (const [path, body] of [
      ["admin/update-user", { userId: actor.user.id, data: { role: "user" } }],
      ["admin/set-role", { userId: actor.user.id, role: "user" }],
    ] as const) {
      const response = await f.call(path, body, actor.cookie);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: "CANNOT_REMOVE_OWN_ADMIN_ROLE",
      });
    }
    expect(
      (
        await f.call(
          "admin/update-user",
          { userId: actor.user.id, data: { name: "Renamed admin" } },
          actor.cookie,
        )
      ).status,
    ).toBe(200);
    expect(f.database.session).toHaveLength(1);
  });

  test("role revocation applies to existing sessions and foreign origins cannot mutate users", async () => {
    const f = fixture();
    const actor = await f.seed();
    const other = await f.seed("admin", "other@example.invalid");
    expect(
      (
        await f.call(
          "admin/create-user",
          newUser,
          actor.cookie,
          "https://untrusted.invalid",
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await f.call(
          "admin/set-role",
          { userId: other.user.id, role: "user" },
          actor.cookie,
        )
      ).status,
    ).toBe(200);
    expect(
      (await f.call("admin/create-user", newUser, other.cookie)).status,
    ).toBe(403);
    expect(f.database.user).toHaveLength(2);
  });
});
