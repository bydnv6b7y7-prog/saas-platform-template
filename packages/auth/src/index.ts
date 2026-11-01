import {
  canStartCheckout,
  withAdminAccess,
} from "@northwind/billing";
import { db } from "@northwind/db";
import * as schema from "@northwind/db/schema/auth";
import { APPLE_APPLICATION } from "@northwind/env/apple-application";
import { resolvePostHogDeletionConfig } from "@northwind/env/posthog";
import { env } from "@northwind/env/server";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";

import { adminAccess, createAdminAccess } from "./admin";
import { appStoreBilling } from "./app-store-billing";
export { appStoreBilling } from "./app-store-billing";
import {
  createAccountDeletion,
  createPostHogPersonDeleter,
} from "./account-deletion";
import { createSocialProviderConfiguration } from "./social-providers";
import {
  createStripeBilling,
  type StripeBillingService,
} from "./stripe-billing";
import { getUserBillingStatus as readUserBillingStatus } from "./subscription-status";
import { serverAnalytics, signupAuthMethodFromContext } from "./analytics";
import { createEmailSender } from "./email";
import { createEmailVerificationOptions } from "./email-verification";

const cloudflareEmailSender = createEmailSender(env);
/** The one configured sender, shared with product notifications such as app feedback. */
export const sendPlatformEmail = cloudflareEmailSender;
const emailVerificationOptions = createEmailVerificationOptions(cloudflareEmailSender);

const socialAuth = createSocialProviderConfiguration({
  googleClientId: env.GOOGLE_CLIENT_ID,
  googleIosClientId: env.GOOGLE_IOS_CLIENT_ID,
  googleClientSecret: env.GOOGLE_CLIENT_SECRET,
  githubClientId: env.GITHUB_CLIENT_ID,
  githubClientSecret: env.GITHUB_CLIENT_SECRET,
  appleClientId: env.APPLE_CLIENT_ID,
  appleAppBundleIdentifier: APPLE_APPLICATION.bundleId,
  appleTeamId: env.APPLE_TEAM_ID,
  appleKeyId: env.APPLE_KEY_ID,
  applePrivateKeyBase64: env.APPLE_PRIVATE_KEY_BASE64,
});

export const enabledSocialProviderIds = socialAuth.enabledProviderIds;

export const stripeBilling: StripeBillingService = createStripeBilling({
  NODE_ENV: env.NODE_ENV,
  DEPLOY_STAGE: env.DEPLOY_STAGE,
  STRIPE_SECRET_KEY: env.STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET: env.STRIPE_WEBHOOK_SECRET,
  STRIPE_PRICE_PRO_MONTHLY: env.STRIPE_PRICE_PRO_MONTHLY,
  STRIPE_PRICE_PRO_YEARLY: env.STRIPE_PRICE_PRO_YEARLY,
});

const postHogDeletion = resolvePostHogDeletionConfig(env);
const accountDeletion = createAccountDeletion({
  stripe: stripeBilling,
  sendEmail: cloudflareEmailSender,
  secret: env.BETTER_AUTH_SECRET,
  deletePostHogPerson: postHogDeletion.configured
    ? createPostHogPersonDeleter(postHogDeletion)
    : null,
});

export function getUserBillingStatus(userId: string) {
  return readUserBillingStatus(userId, stripeBilling);
}

function createAuth() {
  return betterAuth({
    ...emailVerificationOptions,
    database: drizzleAdapter(db, {
      provider: "pg",

      schema: schema,
    }),
    trustedOrigins: [
      env.CORS_ORIGIN,
      ...(enabledSocialProviderIds.includes("apple") ? ["https://appleid.apple.com"] : []),
    ],
    databaseHooks: {
      user: {
        create: {
          after: async (user, context) => {
            const authMethod = signupAuthMethodFromContext(context);
            if (!authMethod) return;
            serverAnalytics.captureUserSignedUp({
              authMethod,
              createdAt: user.createdAt,
              userId: user.id,
            });
          },
        },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (context) => {
        if (!stripeBilling.configured || context.path !== "/subscription/upgrade") return;

        const session = await getSessionFromCtx(context);
        if (!session) return;
        const billingStatus = await getUserBillingStatus(session.user.id);
        const status = adminAccess.allows(session.user)
          ? withAdminAccess(billingStatus)
          : billingStatus;
        if (!canStartCheckout(status)) {
          throw new APIError("BAD_REQUEST", {
            message:
              status.accessSource === "admin"
                ? "Administrator accounts already include Pro access"
                : "Manage the existing subscription from the billing portal",
          });
        }
      }),
    },
    rateLimit: {
      ...emailVerificationOptions.rateLimit,
      customRules: {
        ...emailVerificationOptions.rateLimit.customRules,
        "/subscription/upgrade": { window: 60, max: 10 },
        "/subscription/billing-portal": { window: 60, max: 10 },
        "/account/delete": { window: 60, max: 5 },
        "/stripe/webhook": false,
      },
    },
    socialProviders: socialAuth.providers,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    plugins: [
      createAdminAccess(env.ADMIN_USER_IDS, {
        onDeleteUser: accountDeletion.deleteUserAccount,
      }).betterAuthPlugin(),
      accountDeletion.plugin,
      ...(stripeBilling.plugin ? [stripeBilling.plugin] : []),
      ...(appStoreBilling.plugin ? [appStoreBilling.plugin] : []),
      ...emailVerificationOptions.plugins,
    ],
  });
}

type AppAuth = Pick<ReturnType<typeof createAuth>, "handler"> & {
  api: Pick<ReturnType<typeof createAuth>["api"], "getSession" | "runAppStoreMaintenance">;
};

export const auth: AppAuth = createAuth();

export function shutdownAnalytics(): Promise<void> {
  return serverAnalytics.shutdown();
}
