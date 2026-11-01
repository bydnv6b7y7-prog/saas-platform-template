import { db } from "@northwind/db";
import {
  OPERATIONAL_SETTINGS_DEFAULTS,
  operationalSettingsSchema,
} from "@northwind/env/operational-settings";

import { createSettingsStore, type SettingsDefinition } from "./settings-store";

export const operationalSettingsDefinition: SettingsDefinition<typeof operationalSettingsSchema> = {
  scope: "operations",
  schema: operationalSettingsSchema,
  defaults: OPERATIONAL_SETTINGS_DEFAULTS,
};

const store = createSettingsStore(db, operationalSettingsDefinition);

/** Read once at the beginning of each request. */
export const readOperationalSettings = store.read;
