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
