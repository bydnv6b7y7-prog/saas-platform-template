import { createAppleGateway, type AppleConfiguration } from "./apple";
import { createAppStorePlugin } from "./plugin";
import { createAppStoreService } from "./service";
import type { AppStoreEnvironment, AppStoreEvent, AppStoreStore, ProductMapping } from "./types";

export type AppStoreOptions = {
  apple: AppleConfiguration;
  environments: readonly AppStoreEnvironment[];
  products: readonly ProductMapping[];
  store: AppStoreStore;
  reverifyIntervalMs?: number;
  reconcileIntervalMs?: number;
  onEvent?: (event: AppStoreEvent) => void;
};
export function appStore(options: AppStoreOptions) {
  let observe = options.onEvent;
  const gateway = createAppleGateway({ ...options, onEvent: event => observe?.(event) });
  const service = createAppStoreService({ ...options, bundleId: options.apple.bundleId, gateway });
  observe = event => service.event(event.name, event.code, event.environment, event);
  return { ...createAppStorePlugin(service), service };
}
export { AppStoreError } from "./errors";
export { startAppStoreMaintenance } from "./service";
export type { AppStoreService } from "./service";
export type * from "./types";
