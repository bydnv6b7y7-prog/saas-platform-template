import { describe, expect, test } from "bun:test";
import dotenv from "dotenv";

import { APPLE_APPLICATION } from "./apple-application";
import { appStoreDeploymentLines } from "./app-store-deployment";

const credentials = {
  APP_STORE_ISSUER_ID: "fixture-issuer",
  APP_STORE_KEY_ID: "fixture-key",
  APP_STORE_PRIVATE_KEY_BASE64: "Zml4dHVyZQ==",
};
const read = (source: Record<string, string>, existing: Record<string, string> = {}) =>
  dotenv.parse(appStoreDeploymentLines(source, existing).join("\n"));

describe("App Store production provisioning", () => {
  test("preserves existing production credentials and disabled state when no overrides are supplied", () => {
    expect(read({}, { ...credentials, APP_STORE_ENABLED: "false", APP_STORE_ENVIRONMENTS: "Production,Sandbox" }))
      .toEqual({ ...credentials, APP_STORE_ENABLED: "false", APP_STORE_ENVIRONMENTS: "Production,Sandbox" });
  });
  test("rotates credentials as a complete group and normalizes the environment policy", () => {
    expect(read({ ...credentials, APP_STORE_ENVIRONMENTS: "Sandbox, Production,Sandbox" }, {
      APP_STORE_ISSUER_ID: "old-issuer", APP_STORE_KEY_ID: "old-key", APP_STORE_PRIVATE_KEY_BASE64: "old-fixture",
    })).toEqual({ ...credentials, APP_STORE_ENABLED: "true", APP_STORE_ENVIRONMENTS: "Sandbox,Production" });
    expect(() => read({ APP_STORE_KEY_ID: "replacement" }, credentials)).toThrow("complete App Store credential group");
  });
  test("requires complete credentials for enabled deployments and honors explicit disablement", () => {
    expect(() => read({})).toThrow("explicitly set APP_STORE_ENABLED=false");
    expect(read({ APP_STORE_ENABLED: "false" })).toEqual({ APP_STORE_ENABLED: "false", APP_STORE_ENVIRONMENTS: "Production" });
  });
  test("validates deprecated identities without writing them into the new environment", () => {
    const result = read({ ...credentials, APP_STORE_BUNDLE_ID: APPLE_APPLICATION.bundleId,
      APPLE_APP_BUNDLE_IDENTIFIER: APPLE_APPLICATION.bundleId,
      APP_STORE_APP_APPLE_ID: String(APPLE_APPLICATION.appAppleId),
      APP_STORE_SUBSCRIPTION_GROUP_IDS: APPLE_APPLICATION.subscriptionGroupId });
    expect(Object.keys(result)).toHaveLength(5);
    expect(() => read({ ...credentials, APP_STORE_SUBSCRIPTION_GROUP_IDS: "123" })).toThrow("APP_STORE_SUBSCRIPTION_GROUP_IDS");
  });
  test("keeps explicit maintenance overrides and rejects unsafe serialization without exposing secrets", () => {
    expect(read({ ...credentials, APP_STORE_REVERIFY_INTERVAL_SECONDS: "1200" }).APP_STORE_REVERIFY_INTERVAL_SECONDS).toBe("1200");
    expect(() => read({ ...credentials, APP_STORE_PRIVATE_KEY_BASE64: "do-not-log\nINJECTED=true" }))
      .toThrow("APP_STORE_PRIVATE_KEY_BASE64 must be a single-line deployment value");
  });
});
