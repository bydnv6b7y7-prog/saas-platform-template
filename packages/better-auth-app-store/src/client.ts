import type { BetterAuthClientPlugin } from "better-auth/client";
import type { appStore } from "./index";

export function appStoreClient() {
  return {
    id: "app-store-client",
    $InferServerPlugin: {} as ReturnType<typeof appStore>,
    pathMethods: {
      "/app-store/account-token": "POST",
      "/app-store/sync": "POST",
      "/app-store/restore": "POST",
    },
  } satisfies BetterAuthClientPlugin;
}
export type { AppStoreStatus, AppStoreSyncResult } from "./types";
