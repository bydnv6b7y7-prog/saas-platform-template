import { z } from "zod";

/**
 * The native iOS app: public identity shared by native sign-in, App Store billing, Admin and the
 * app's remote settings. This is the one file to edit for a different app (the template exporter
 * rewrites it); credentials stay in deployment variables.
 */
export const APPLE_APPLICATION = {
  name: "Northwind",
  bundleId: "com.example.app",
  appAppleId: 0,
  subscriptionGroupId: "00000000",
  products: [
    {
      productId: "pro.monthly",
      displayName: "Pro monthly",
      entitlement: "pro"
    },
    {
      productId: "pro.yearly",
      displayName: "Pro yearly",
      entitlement: "pro"
    }
  ],
  reviewTriggers: {
    milestoneReached: "After a milestone"
  },
  feedbackContexts: {
    purchaseFailed: "Purchase failed"
  }
} as const;

type Keys<T> = [keyof T & string, ...(keyof T & string)[]];
export const REVIEW_TRIGGERS = Object.keys(APPLE_APPLICATION.reviewTriggers) as Keys<typeof APPLE_APPLICATION.reviewTriggers>;
export const FEEDBACK_CONTEXTS = Object.keys(APPLE_APPLICATION.feedbackContexts) as Keys<typeof APPLE_APPLICATION.feedbackContexts>;

/**
 * Deprecated deployment values are assertions, never alternate sources of scope.
 * Keeping them optional lets existing deployments remove them without changing identity.
 */
export const appleApplicationLegacyIdentitySchema = z.object({
  APP_STORE_BUNDLE_ID: z.string().trim().refine(
    (value) => value === APPLE_APPLICATION.bundleId,
    "APP_STORE_BUNDLE_ID must match the application catalog; remove this deprecated override",
  ).optional(),
  APPLE_APP_BUNDLE_IDENTIFIER: z.string().trim().refine(
    (value) => value === APPLE_APPLICATION.bundleId,
    "APPLE_APP_BUNDLE_IDENTIFIER must match the application catalog; remove this deprecated override",
  ).optional(),
  APP_STORE_APP_APPLE_ID: z.coerce.number().refine(
    (value) => value === APPLE_APPLICATION.appAppleId,
    "APP_STORE_APP_APPLE_ID must match the application catalog; remove this deprecated override",
  ).optional(),
  APP_STORE_SUBSCRIPTION_GROUP_IDS: z.string().refine(
    (value) => value.split(",").every((group) => group.trim() === APPLE_APPLICATION.subscriptionGroupId),
    "APP_STORE_SUBSCRIPTION_GROUP_IDS must match the application catalog; remove this deprecated override",
  ).optional(),
});
