import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import * as authSchema from "@northwind/db/schema/auth";
import { usageBuckets } from "@northwind/db/schema/usage";
import { iapAccount, iapSubscription } from "@northwind/db/schema/iap";

import {
  createAccountDeletion,
  usageSubjectHash,
  type AccountDeletionDatabase,
} from "./account-deletion";
import { createAdminAccess } from "./admin";
import { createEmailVerificationOptions } from "./email-verification";
import type { EmailMessage, SendEmail } from "./email";

const url = process.env.ACCOUNT_DELETION_TEST_DATABASE_URL;
if (url) {
  const parsed = new URL(url);
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    parsed.pathname !== "/northwind_account_deletion_test"
  ) {
    throw new Error(
      "Use only the dedicated local northwind_account_deletion_test database",
    );
  }
}

(url ? describe : describe.skip)(
  "account deletion / real PostgreSQL migrations",
  () => {
    if (!url) return;
    const connection = new SQL(url);
    const database = drizzle(connection);
    const suffix = crypto.randomUUID();
    const password = "PostgresFixturePassword123!";
    const baseURL = "http://localhost:4299";
    const secret =
      "isolated-account-deletion-postgres-secret-with-32-chars";

    const stripeCancels: string[] = [];
    const stripeFailures = new Set<string>();
    const sentEmails: EmailMessage[] = [];
    const postHogDeletions: string[] = [];

    const sendEmail: SendEmail = async (message) => {
      sentEmails.push(message);
    };
    const deletion = createAccountDeletion({
      stripe: {
        configured: true,
        async cancelSubscriptionAtPeriodEnd(stripeSubscriptionId) {
          if (stripeFailures.has(stripeSubscriptionId)) {
            throw new Error("stripe unavailable");
          }
          stripeCancels.push(stripeSubscriptionId);
        },
      },
      sendEmail,
      secret,
      deletePostHogPerson: async (distinctId) => {
        postHogDeletions.push(distinctId);
      },
      // bun-sql and node-postgres drizzle instances only differ in generic
      // query-result typing; the runtime shape is identical.
      db: database as unknown as AccountDeletionDatabase,
    });

    const verification = createEmailVerificationOptions(async () => {});
    const auth = betterAuth({
      ...verification,
      database: drizzleAdapter(database, {
        provider: "pg",
        schema: authSchema,
      }),
      baseURL,
      secret,
      plugins: [
        createAdminAccess("", {
          onDeleteUser: deletion.deleteUserAccount,
        }).betterAuthPlugin(),
        deletion.plugin,
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

    const signUpVerified = async (email: string) => {
      expect(
        (
          await call("sign-up/email", { email, password, name: "Fixture" })
        ).status,
      ).toBe(200);
      const [account] = await database
        .update(authSchema.user)
        .set({ emailVerified: true })
        .where(eq(authSchema.user.email, email))
        .returning();
      return account!;
    };

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

    const seedSubscription = async (userId: string, stripeSubscriptionId: string) => {
      await database.insert(authSchema.subscription).values({
        id: crypto.randomUUID(),
        plan: "pro",
        referenceId: userId,
        stripeCustomerId: `cus_${suffix}`,
        stripeSubscriptionId,
        status: "active",
      });
    };

    const seedIapRows = async (userId: string) => {
      const appAccountToken = crypto.randomUUID();
      await database.insert(iapAccount).values({
        id: crypto.randomUUID(),
        bundleId: iapBundleId,
        userId,
        appAccountToken,
      });
      await database.insert(iapSubscription).values({
        id: crypto.randomUUID(),
        bundleId: iapBundleId,
        environment: "Sandbox",
        originalTransactionId: `txn-${suffix}`,
        userId,
        claimedAt: new Date(),
      });
      return iapBundleId;
    };

    const emails = {
      operator: `operator-${suffix}@example.invalid`,
      selfService: `self-${suffix}@example.invalid`,
      stripeFailure: `stripe-fail-${suffix}@example.invalid`,
      adminTarget: `admin-target-${suffix}@example.invalid`,
    };
    const iapBundleId = `com.example.${suffix}`;

    beforeAll(async () => {
      await migrate(database, {
        migrationsFolder: new URL("../../db/src/migrations", import.meta.url)
          .pathname,
      });
    });

    afterAll(async () => {
      try {
        await database
          .delete(iapSubscription)
          .where(eq(iapSubscription.bundleId, iapBundleId));
        await database
          .delete(iapAccount)
          .where(eq(iapAccount.bundleId, iapBundleId));
        await database
          .delete(authSchema.subscription)
          .where(eq(authSchema.subscription.stripeCustomerId, `cus_${suffix}`));
        await database
          .delete(authSchema.user)
          .where(eq(authSchema.user.email, emails.operator));
      } finally {
        await connection.close();
      }
    });

    test("self-service deletion validates the typed email then removes the account end to end", async () => {
      const account = await signUpVerified(emails.selfService);
      const cookie = await signIn(emails.selfService);
      await seedSubscription(account.id, `sub_ok_${suffix}`);
      const bundleId = await seedIapRows(account.id);
      await database.insert(authSchema.verification).values({
        id: crypto.randomUUID(),
        identifier: `email-verification-otp-${emails.selfService}`,
        value: "fixture",
        expiresAt: new Date(Date.now() + 60_000),
      });
      await database.insert(usageBuckets).values({
        subjectHash: usageSubjectHash(account.id, secret),
        action: "assistant_request",
        windowSeconds: 60,
        bucketStartedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      });

      const mismatch = await call("account/delete", {
        email: "wrong@example.invalid",
      }, cookie);
      expect(mismatch.status).toBe(400);

      const deleted = await call("account/delete", {
        email: emails.selfService,
      }, cookie);
      expect(deleted.status).toBe(200);
      expect(await (deleted.json() as Promise<{ success: boolean }>)).toEqual({
        success: true,
      });
      // The session cookie is cleared server-side.
      expect(
        deleted.headers
          .getSetCookie()
          .some((value) => value.includes("better-auth.session_token=")),
      ).toBe(true);

      expect(
        await database
          .select()
          .from(authSchema.user)
          .where(eq(authSchema.user.id, account.id)),
      ).toHaveLength(0);
      expect(
        await database
          .select()
          .from(authSchema.verification)
          .where(
            eq(
              authSchema.verification.identifier,
              `email-verification-otp-${emails.selfService}`,
            ),
          ),
      ).toHaveLength(0);
      expect(
        await database
          .select()
          .from(usageBuckets)
          .where(
            eq(
              usageBuckets.subjectHash,
              usageSubjectHash(account.id, secret),
            ),
          ),
      ).toHaveLength(0);
      // The Stripe ledger is retained and the IAP rows become tombstones.
      expect(
        await database
          .select()
          .from(authSchema.subscription)
          .where(
            eq(
              authSchema.subscription.stripeSubscriptionId,
              `sub_ok_${suffix}`,
            ),
          ),
      ).toHaveLength(1);
      const [iapSub] = await database
        .select()
        .from(iapSubscription)
        .where(eq(iapSubscription.bundleId, bundleId));
      expect(iapSub?.userId).toBeNull();
      expect(iapSub?.claimedAt).not.toBeNull();
      const [iapAcc] = await database
        .select()
        .from(iapAccount)
        .where(eq(iapAccount.bundleId, bundleId));
      expect(iapAcc?.userId).toBeNull();

      expect(stripeCancels).toEqual([`sub_ok_${suffix}`]);
      expect(sentEmails.at(-1)?.to).toBe(emails.selfService);
      expect(postHogDeletions).toEqual([account.id]);
      expect(await (await call("get-session", undefined, cookie)).json()).toBeNull();
    });

    test("stripe cancellation failures never block deletion", async () => {
      const account = await signUpVerified(emails.stripeFailure);
      const cookie = await signIn(emails.stripeFailure);
      await seedSubscription(account.id, `sub_fail_${suffix}`);
      stripeFailures.add(`sub_fail_${suffix}`);

      const response = await call("account/delete", {
        email: emails.stripeFailure,
      }, cookie);
      expect(response.status).toBe(200);
      expect(
        await database
          .select()
          .from(authSchema.user)
          .where(eq(authSchema.user.id, account.id)),
      ).toHaveLength(0);
      expect(
        await database
          .select()
          .from(authSchema.subscription)
          .where(
            eq(
              authSchema.subscription.stripeSubscriptionId,
              `sub_fail_${suffix}`,
            ),
          ),
      ).toHaveLength(1);
    });

    test("admin removal runs the same routine with admin guards intact", async () => {
      const operator = await signUpVerified(emails.operator);
      await database
        .update(authSchema.user)
        .set({ role: "admin" })
        .where(eq(authSchema.user.id, operator.id));
      const operatorCookie = await signIn(emails.operator);

      const target = await signUpVerified(emails.adminTarget);
      await seedSubscription(target.id, `sub_admin_${suffix}`);

      // Guards: self-removal and unknown users are rejected before any work.
      expect(
        (
          await call(
            "admin/remove-user",
            { userId: operator.id },
            operatorCookie,
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await call(
            "admin/remove-user",
            { userId: crypto.randomUUID() },
            operatorCookie,
          )
        ).status,
      ).toBe(404);

      const removed = await call(
        "admin/remove-user",
        { userId: target.id },
        operatorCookie,
      );
      expect(removed.status).toBe(200);
      expect(
        await database
          .select()
          .from(authSchema.user)
          .where(eq(authSchema.user.id, target.id)),
      ).toHaveLength(0);
      expect(stripeCancels).toContain(`sub_admin_${suffix}`);
      expect(sentEmails.at(-1)?.to).toBe(emails.adminTarget);
      // The operator session survives.
      expect(
        await (await call("get-session", undefined, operatorCookie)).json(),
      ).toMatchObject({ user: { id: operator.id } });
    });
  },
);
