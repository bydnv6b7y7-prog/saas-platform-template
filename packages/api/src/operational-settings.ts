import { db } from "@northwind/db";
import {
  OPERATIONAL_SETTINGS_DEFAULTS,
  operationalSettingsFromEnvironment,
  operationalSettingsSchema,
  type OperationalSettings,
} from "@northwind/env/operational-settings";
import { env } from "@northwind/env/server";

import { createSettingsStore, type SettingsDefinition, type SettingsSnapshot } from "./settings-store";

export type OperationalSettingsSnapshot = SettingsSnapshot<OperationalSettings>;

export const operationalSettingsDefinition: SettingsDefinition<typeof operationalSettingsSchema> = {
  scope: "operations",
  schema: operationalSettingsSchema,
  defaults: OPERATIONAL_SETTINGS_DEFAULTS,
  deploymentValues: () => operationalSettingsFromEnvironment(env),
};

/** Inject a dedicated database for integration tests. */
export function createOperationalSettingsStore(database: typeof db, deploymentValues: () => OperationalSettings) {
  return createSettingsStore(database, { ...operationalSettingsDefinition, deploymentValues });
}

const store = createSettingsStore(db, operationalSettingsDefinition);

/** Read once at the beginning of each request. */
export const readOperationalSettings = store.read;
export const updateOperationalSettings = store.update;
export const readOperationalSettingsHistory = store.history;
