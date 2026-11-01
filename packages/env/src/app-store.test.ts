import { expect, test } from "bun:test";
import { z } from "zod";
import { APPLE_APPLICATION, appleApplicationLegacyIdentitySchema } from "./apple-application";
import { appStoreMaintenanceSchema, appStoreServerSchema, parseAppStoreEnvironments } from "./app-store";
import { platformServerSchema } from "./platform-server-schema";

test("environment parsing accepts only explicit Apple environments and normalizes duplicates", () => {
  expect(parseAppStoreEnvironments()).toEqual(["Production"]);
  expect(parseAppStoreEnvironments(" Sandbox, Production, Sandbox ")).toEqual(["Sandbox", "Production"]);
  expect(z.object(appStoreServerSchema).parse({ APP_STORE_ENVIRONMENTS: " Production, Sandbox,Production " }).APP_STORE_ENVIRONMENTS)
    .toBe("Production,Sandbox");
  for (const value of ["", " ", "Production,", ",Sandbox", "production", "Xcode", "LocalTesting", "Production,Sandbox,Xcode"]) {
    expect(() => parseAppStoreEnvironments(value)).toThrow("APP_STORE_ENVIRONMENTS");
    expect(z.object(appStoreServerSchema).safeParse({ APP_STORE_ENVIRONMENTS: value }).success).toBe(false);
  }
});

test("the host environment accepts absent or matching deprecated identity assertions", () => {
  const schema = z.object({ ...platformServerSchema, ...appStoreServerSchema }).pick({
    APP_STORE_BUNDLE_ID: true, APPLE_APP_BUNDLE_IDENTIFIER: true,
    APP_STORE_APP_APPLE_ID: true, APP_STORE_SUBSCRIPTION_GROUP_IDS: true,
  });
  expect(schema.parse({})).toEqual({});
  expect(schema.parse({
    APP_STORE_BUNDLE_ID: ` ${APPLE_APPLICATION.bundleId} `,
    APPLE_APP_BUNDLE_IDENTIFIER: APPLE_APPLICATION.bundleId,
    APP_STORE_APP_APPLE_ID: String(APPLE_APPLICATION.appAppleId),
    APP_STORE_SUBSCRIPTION_GROUP_IDS: ` ${APPLE_APPLICATION.subscriptionGroupId},${APPLE_APPLICATION.subscriptionGroupId} `,
  })).toMatchObject({ APP_STORE_BUNDLE_ID: APPLE_APPLICATION.bundleId, APP_STORE_APP_APPLE_ID: APPLE_APPLICATION.appAppleId });
  for (const value of [
    { APP_STORE_BUNDLE_ID: "other.app" }, { APPLE_APP_BUNDLE_IDENTIFIER: "other.app" },
    { APP_STORE_APP_APPLE_ID: "123" }, { APP_STORE_SUBSCRIPTION_GROUP_IDS: "123" },
    { APP_STORE_SUBSCRIPTION_GROUP_IDS: "" }, { APP_STORE_SUBSCRIPTION_GROUP_IDS: `${APPLE_APPLICATION.subscriptionGroupId},` },
  ]) {
    expect(schema.safeParse(value).success).toBe(false);
    expect(appleApplicationLegacyIdentitySchema.safeParse(value).success).toBe(false);
  }
});

test("maintenance defaults and valid advanced bounds are shared", () => {
  expect(appStoreMaintenanceSchema.parse({})).toEqual({
    APP_STORE_REVERIFY_INTERVAL_SECONDS: 900, APP_STORE_RECONCILE_INTERVAL_SECONDS: 21600,
  });
  expect(appStoreMaintenanceSchema.parse({
    APP_STORE_REVERIFY_INTERVAL_SECONDS: "21600", APP_STORE_RECONCILE_INTERVAL_SECONDS: "1",
  })).toEqual({ APP_STORE_REVERIFY_INTERVAL_SECONDS: 21600, APP_STORE_RECONCILE_INTERVAL_SECONDS: 1 });
  for (const value of [
    { APP_STORE_REVERIFY_INTERVAL_SECONDS: 299 }, { APP_STORE_REVERIFY_INTERVAL_SECONDS: 21601 },
    { APP_STORE_REVERIFY_INTERVAL_SECONDS: 300.5 }, { APP_STORE_RECONCILE_INTERVAL_SECONDS: 0 },
    { APP_STORE_RECONCILE_INTERVAL_SECONDS: 86401 },
  ]) expect(appStoreMaintenanceSchema.safeParse(value).success).toBe(false);
});
