import { acquireAdvisoryLock } from "@northwind/db";

import { logError, logInfo, logWarn } from "../logging";
import { mastraStorage } from "./storage";

const MASTRA_RETENTION_LOCK = 72_960_414;
const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const STARTED_KEY = Symbol.for("mastra.retention.started");

type MastraRetentionController = {
  stopAndDrain(): Promise<void>;
};

type GlobalRegistry = {
  [STARTED_KEY]?: MastraRetentionController;
};

async function retentionTick(): Promise<void> {
  let lock: Awaited<ReturnType<typeof acquireAdvisoryLock>> = null;

  try {
    lock = await acquireAdvisoryLock(MASTRA_RETENTION_LOCK);
    if (!lock) return;
    const results = await mastraStorage.prune({
      maxRows: 50_000,
      pauseMs: 25,
    });
    const deletedRows = results.reduce((total, result) => total + result.deleted, 0);
    const incompleteTables = results.filter((result) => !result.done).length;
    if (incompleteTables > 0) {
      logWarn("mastra_retention_incomplete", { deletedRows, incompleteTables });
    } else if (deletedRows > 0) {
      logInfo("mastra_retention_completed", { deletedRows });
    }
  } catch (error) {
    logError("mastra_retention_failed", error);
  } finally {
    if (lock) {
      await lock.release().catch((error) => {
        logError("mastra_retention_lock_release_failed", error);
      });
    }
  }
}

export function startMastraRetentionScheduler(): MastraRetentionController {
  const registry = globalThis as unknown as GlobalRegistry;
  if (registry[STARTED_KEY]) return registry[STARTED_KEY];

  let activeRun: Promise<void> | null = null;
  let accepting = true;
  const startTick = () => {
    if (!accepting || activeRun) return;
    activeRun = retentionTick().finally(() => {
      activeRun = null;
    });
  };

  startTick();
  const timer = setInterval(startTick, RETENTION_INTERVAL_MS);
  timer.unref();

  const controller: MastraRetentionController = {
    async stopAndDrain() {
      accepting = false;
      clearInterval(timer);
      if (activeRun) await activeRun;
      if (registry[STARTED_KEY] === controller) delete registry[STARTED_KEY];
    },
  };
  registry[STARTED_KEY] = controller;
  return controller;
}
