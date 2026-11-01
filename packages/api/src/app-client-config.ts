import { db, desc, eq, sql } from "@northwind/db";
import { appClientConfig, appClientConfigAudit } from "@northwind/db/schema/app-feedback";
import {
  APP_CLIENT_CONFIG_DEFAULTS,
  appClientConfigSchema,
  type AppClientConfig,
} from "@northwind/env/app-client-config";
import { TRPCError } from "@trpc/server";

export type AppClientConfigSnapshot = {
  values: AppClientConfig;
  revision: number;
  source: "database" | "defaults";
  updatedAt: string | null;
  updatedBy: string | null;
};

type ConfigRow = typeof appClientConfig.$inferSelect;

function snapshot(row: ConfigRow | undefined): AppClientConfigSnapshot {
  return row ? {
    values: appClientConfigSchema.parse(row.values),
    revision: row.revision,
    source: "database",
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
  } : {
    values: appClientConfigSchema.parse(APP_CLIENT_CONFIG_DEFAULTS),
    revision: 0,
    source: "defaults",
    updatedAt: null,
    updatedBy: null,
  };
}

/** Values compared as data: the same settings in a different key order are no change. */
function sameValues(a: AppClientConfig, b: AppClientConfig) {
  const canonical = (value: unknown): unknown => Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]))
      : value;
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/** Inject a dedicated database for integration tests. No process cache: every read is current. */
export function createAppClientConfigStore(database: typeof db) {
  return {
    async read(): Promise<AppClientConfigSnapshot> {
      const [row] = await database.select().from(appClientConfig).where(eq(appClientConfig.id, 1));
      return snapshot(row);
    },

    async update(input: {
      expectedRevision: number;
      values: AppClientConfig;
      actorId: string;
    }): Promise<AppClientConfigSnapshot> {
      const values = appClientConfigSchema.parse(input.values);
      return database.transaction(async (transaction) => {
        // A lock of its own, apart from operational settings (812, 1) and ingestion.
        await transaction.execute(sql`select pg_advisory_xact_lock(812, 2)`);
        const [row] = await transaction.select().from(appClientConfig).where(eq(appClientConfig.id, 1));
        const current = snapshot(row);
        if (current.revision !== input.expectedRevision) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "App settings changed. Reload the latest values before saving.",
          });
        }
        if (sameValues(values, current.values)) return current;

        const revision = current.revision + 1;
        const updatedAt = new Date();
        const next = { values, revision, updatedAt, updatedBy: input.actorId };
        await transaction.insert(appClientConfig).values({ id: 1, ...next })
          .onConflictDoUpdate({ target: appClientConfig.id, set: next });
        await transaction.insert(appClientConfigAudit).values({
          revision,
          actorId: input.actorId,
          createdAt: updatedAt,
          before: current.values,
          after: values,
        });
        return snapshot({ id: 1, ...next });
      });
    },

    async history() {
      const rows = await database.select().from(appClientConfigAudit)
        .orderBy(desc(appClientConfigAudit.revision)).limit(20);
      return rows.map((row) => ({
        revision: row.revision,
        actorId: row.actorId,
        createdAt: row.createdAt.toISOString(),
        before: appClientConfigSchema.parse(row.before),
        after: appClientConfigSchema.parse(row.after),
      }));
    },
  };
}

const store = createAppClientConfigStore(db);

export const readAppClientConfig = store.read;
export const updateAppClientConfig = store.update;
export const readAppClientConfigHistory = store.history;
