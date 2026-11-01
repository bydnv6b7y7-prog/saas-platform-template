import { purgeFeedbackScreenshots } from "@northwind/api/app-feedback";
import { userObjects } from "@northwind/api/user-objects";

import { captureRequestError, logWarn } from "./logging";

type Purge = () => Promise<{ deleted: number; failed: number }>;

/**
 * Objects that should no longer exist are deleted hourly, on a timer of their
 * own, so an account deletion is honoured within the hour even when nothing
 * else happens. Several instances may run it; deleting twice is harmless.
 */
export function startStorageCleanup(purges: Record<string, Purge> = {
  app_feedback_screenshot: purgeFeedbackScreenshots,
  user_object: () => userObjects.purge(),
}) {
  const run = () => {
    for (const [name, purge] of Object.entries(purges)) {
      void purge().then((result) => {
        if (result.failed > 0) logWarn("storage_purge_incomplete", { purpose: name, ...result });
      }).catch((error) => captureRequestError(error, { operation: `${name}_purge` }));
    }
  };
  const first = setTimeout(run, 60_000);
  const every = setInterval(run, 3_600_000);
  first.unref?.();
  every.unref?.();
  return () => { clearTimeout(first); clearInterval(every); };
}
