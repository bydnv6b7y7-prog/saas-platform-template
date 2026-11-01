import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { eq, inArray } from "drizzle-orm";
import * as authSchema from "@northwind/db/schema/auth";

import { createAdminAccess } from "./admin";
import { createEmailVerificationOptions } from "./email-verification";

const url = process.env.ADMIN_USERS_TEST_DATABASE_URL;
if (url) {
  const parsed = new URL(url);
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    parsed.pathname !== "/northwind_admin_users_test"
  ) {
    throw new Error(
      "Use only the dedicated local northwind_admin_users_test database",
    );
  }
}

(url ? describe : describe.skip)(
  "admin users / real PostgreSQL migrations",
  () => {
    if (!url) return;
    const connection = new SQL(url);
    const database = drizzle(connection);
    const suffix = crypto.randomUUID();
    const operatorEmail = `operator-${suffix}@example.invalid`;
    const readerEmail = `reader-${suffix}@example.invalid`;
    const updatedEmail = `updated-${suffix}@example.invalid`;
    const password = "PostgresFixturePassword123!";
    const baseURL = "http://localhost:4299";
    const verification = createEmailVerificationOptions(async () => {});
    const auth = betterAuth({
      ...verification,
      database: drizzleAdapter(database, {
        provider: "pg",
        schema: authSchema,
      }),
      baseURL,
      secret:
        "isolated-admin-postgres-secret-with-at-least-thirty-two-characters",
      plugins: [
        createAdminAccess("").betterAuthPlugin(),
        ...verification.plugins,
      ],
      rateLimit: { enabled: false },
      logger: { disabled: true },
    });
    const call = (path: string, body?: object, cookie?: string) =>
      auth.handler(
        new Request(`${baseURL}/api/auth/${path}`, {
          method: body ? "POST" : "GET",
          headers: {
            "Content-Type": "application/json",
            Origin: baseURL,
            ...(cookie ? { Cookie: cookie } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
      );
    const signIn = async (email: string) => {
      const response = await call("sign-in/email", { email, password });
      expect(response.status).toBe(200);
      const cookie = response.headers
        .getSetCookie()
        .find((value) => value.startsWith("better-auth.session_token="))
        ?.split(";")[0];
      expect(cookie).toBeTruthy();
      return cookie!;
    };

    beforeAll(async () => {
      await migrate(database, {
        migrationsFolder: new URL("../../db/src/migrations", import.meta.url)
          .pathname,
      });
    });
    afterAll(async () => {
      try {
        await database
          .delete(authSchema.user)
          .where(
            inArray(authSchema.user.email, [
              operatorEmail,
              readerEmail,
              updatedEmail,
            ]),
          );
      } finally {
        await connection.close();
      }
    });

    test("persists CRUD without losing the operator", async () => {
      expect(
        (
          await call("sign-up/email", {
            email: operatorEmail,
            password,
            name: "Postgres operator",
          })
        ).status,
      ).toBe(200);
      const [operator] = await database
        .update(authSchema.user)
        .set({ role: "admin", emailVerified: true })
        .where(eq(authSchema.user.email, operatorEmail))
        .returning();
      const cookie = await signIn(operatorEmail);
      const created = await call(
        "admin/create-user",
        {
          name: "Postgres reader",
          email: readerEmail,
          password,
          role: "user",
          data: { emailVerified: true },
        },
        cookie,
      );
      expect(created.status).toBe(200);
      const { user } = (await created.json()) as { user: { id: string } };
      const readerCookie = await signIn(readerEmail);

      expect(
        (
          await call(
            "admin/update-user",
            {
              userId: user.id,
              data: { name: "Updated reader", email: updatedEmail },
            },
            cookie,
          )
        ).status,
      ).toBe(200);
      const [updated] = await database
        .select()
        .from(authSchema.user)
        .where(eq(authSchema.user.id, user.id));
      expect(updated).toMatchObject({
        name: "Updated reader",
        email: updatedEmail,
        emailVerified: false,
      });
      expect(
        (await call("sign-in/email", { email: updatedEmail, password })).status,
      ).toBe(403);

      expect(
        (await call("admin/remove-user", { userId: user.id }, cookie)).status,
      ).toBe(200);
      expect(
        await database
          .select()
          .from(authSchema.user)
          .where(eq(authSchema.user.id, user.id)),
      ).toHaveLength(0);
      expect(
        await database
          .select()
          .from(authSchema.account)
          .where(eq(authSchema.account.userId, user.id)),
      ).toHaveLength(0);
      expect(
        await database
          .select()
          .from(authSchema.session)
          .where(eq(authSchema.session.userId, user.id)),
      ).toHaveLength(0);
      expect(
        await (await call("get-session", undefined, readerCookie)).json(),
      ).toBeNull();
      expect(
        await (await call("get-session", undefined, cookie)).json(),
      ).toMatchObject({ user: { id: operator!.id } });
    });
  },
);
