import { expect, test } from "bun:test";
import { z } from "zod";
import { appStoreMaintenanceSchema, appStoreServerSchema, parseAppStoreEnvironments } from "./app-store";

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
