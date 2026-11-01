import { operationsRouter } from "./config-operations";
import { appStoreConfigRouter } from "./config-app-store";
import { appClientConfigRouter } from "./config-app-client";

/** Platform Admin settings; products merge their own config procedures under `config`. */
export const platformConfigRouters = {
  operations: operationsRouter,
  appStore: appStoreConfigRouter,
  appClient: appClientConfigRouter,
};
