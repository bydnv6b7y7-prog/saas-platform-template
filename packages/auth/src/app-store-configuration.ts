import type { ProductMapping } from "@northwind/better-auth-app-store/types";
import { APPLE_APPLICATION, appleApplicationLegacyIdentitySchema } from "@northwind/env/apple-application";
import { APP_STORE_CREDENTIAL_KEYS, appStoreMaintenanceSchema, parseAppStoreEnvironments } from "@northwind/env/app-store";

type Environment = {
  APP_STORE_ENABLED?: boolean;
  APP_STORE_ISSUER_ID?: string;
  APP_STORE_KEY_ID?: string;
  APP_STORE_PRIVATE_KEY_BASE64?: string;
  APP_STORE_BUNDLE_ID?: string;
  APPLE_APP_BUNDLE_IDENTIFIER?: string;
  APP_STORE_APP_APPLE_ID?: number;
  APP_STORE_ENVIRONMENTS?: string;
  APP_STORE_SUBSCRIPTION_GROUP_IDS?: string;
  APP_STORE_REVERIFY_INTERVAL_SECONDS?: number;
  APP_STORE_RECONCILE_INTERVAL_SECONDS?: number;
};
export function resolveAppStoreConfiguration(env: Environment) {
  // Native authentication continues to use this identity even when billing is disabled.
  appleApplicationLegacyIdentitySchema.parse(env);
  if (env.APP_STORE_ENABLED === false) return null;
  const missing = APP_STORE_CREDENTIAL_KEYS.filter(key => !env[key]?.trim());
  if (missing.length) throw new Error(`App Store configuration missing: ${missing.join(", ")}`);
  const environments = parseAppStoreEnvironments(env.APP_STORE_ENVIRONMENTS);
  const maintenance = appStoreMaintenanceSchema.parse(env);
  const products: ProductMapping[] = APPLE_APPLICATION.products.map(({ productId, entitlement }) => ({
    productId, subscriptionGroupId: APPLE_APPLICATION.subscriptionGroupId, entitlement,
  }));
  return {
    apple: {
      bundleId: APPLE_APPLICATION.bundleId, issuerId: env.APP_STORE_ISSUER_ID!, keyId: env.APP_STORE_KEY_ID!,
      privateKey: Buffer.from(env.APP_STORE_PRIVATE_KEY_BASE64!, "base64").toString("utf8"),
      appAppleId: APPLE_APPLICATION.appAppleId,
    },
    environments, products,
    reverifyIntervalMs: maintenance.APP_STORE_REVERIFY_INTERVAL_SECONDS * 1000,
    reconcileIntervalMs: maintenance.APP_STORE_RECONCILE_INTERVAL_SECONDS * 1000,
  };
}
