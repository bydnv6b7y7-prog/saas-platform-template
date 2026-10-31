import { readFileSync } from "node:fs";
import { appStore, type AppStoreEvent } from "@northwind/better-auth-app-store";
import { createAppStoreDrizzleStore } from "@northwind/better-auth-app-store/drizzle";
import { db } from "@northwind/db";
import { iapTables } from "@northwind/db/schema/iap";
import { env } from "@northwind/env/server";
import { resolveAppStoreConfiguration } from "./app-store-configuration";

const config = resolveAppStoreConfiguration(env);
let eventHandler: ((event: AppStoreEvent) => void) | undefined;
const store = config ? createAppStoreDrizzleStore({ db, tables: iapTables, bundleId: config.apple.bundleId, environments: config.environments, reconcileIntervalMs: config.reconcileIntervalMs }) : null;
const plugin = config && store ? appStore({
  ...config, store,
  apple: { ...config.apple, rootCertificates: [readFileSync(new URL(import.meta.resolve("@northwind/better-auth-app-store/certificates/AppleRootCA-G3.cer")))] },
  onEvent: event => eventHandler?.(event),
}) : null;

export const appStoreBilling = {
  configured: plugin !== null, plugin, store,
  service: plugin?.service ?? null,
  bundleId: config?.apple.bundleId ?? null,
  environments: config?.environments ?? [],
  onEvent(handler: (event: AppStoreEvent) => void) { eventHandler = handler; },
};
