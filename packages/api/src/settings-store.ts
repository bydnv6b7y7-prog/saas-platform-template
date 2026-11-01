import { db, desc, eq, sql } from "@northwind/db";
import { runtimeSettings, runtimeSettingsAudit } from "@northwind/db/schema/runtime-settings";
import { TRPCError } from "@trpc/server";
import type { z } from "zod";

export type SettingsSnapshot<T> = {
  values: T;
  revision: number;
  source: "database" | "default";
  updatedAt: string | null;
  updatedBy: string | null;
};

/** One Admin-editable group of runtime settings. The platform owns "operations"; products register their own scopes. */
export type SettingsDefinition<S extends z.ZodObject> = {
  scope: string;
  schema: S;
  /** Values that apply until the first Admin save. */
  defaults: Readonly<z.infer<S>>;
};

type SettingsRow = typeof runtimeSettings.$inferSelect;

/** Inject a dedicated database for integration tests. No process cache or partial overrides. */
export function createSettingsStore<S extends z.ZodObject>(
  database: typeof db,
  { scope, schema, defaults }: SettingsDefinition<S>,
) {
  type Values = z.infer<S>;
  const snapshot = (row: SettingsRow | undefined): SettingsSnapshot<Values> => row ? {
    values: schema.parse(row.values),
    revision: row.revision,
    source: "database",
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
  } : {
    values: schema.parse(defaults),
    revision: 0,
    source: "default",
    updatedAt: null,
    updatedBy: null,
  };

  return {
    async read(): Promise<SettingsSnapshot<Values>> {
      const [row] = await database.select().from(runtimeSettings).where(eq(runtimeSettings.scope, scope));
      return snapshot(row);
    },

    async update(input: { expectedRevision: number; values: Values; actorId: string }): Promise<SettingsSnapshot<Values>> {
      const values = schema.parse(input.values) as Record<string, unknown>;
      return database.transaction(async (transaction) => {
        // Transaction-scoped per-scope lock covers the absent-row case as well as updates.
        await transaction.execute(sql`select pg_advisory_xact_lock(812, hashtext(${scope}))`);
        const [row] = await transaction.select().from(runtimeSettings).where(eq(runtimeSettings.scope, scope));
        const current = snapshot(row);
        if (current.revision !== input.expectedRevision) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Settings changed. Reload the latest values before saving.",
          });
        }
        const before = current.values as Record<string, unknown>;
        if (Object.keys(values).every((key) => values[key] === before[key])) return current;

        const revision = current.revision + 1;
        const updatedAt = new Date();
        const next = { values, revision, updatedAt, updatedBy: input.actorId };
        await transaction.insert(runtimeSettings).values({ scope, ...next })
          .onConflictDoUpdate({ target: runtimeSettings.scope, set: next });
        await transaction.insert(runtimeSettingsAudit).values({
          scope,
          revision,
          actorId: input.actorId,
          createdAt: updatedAt,
          before,
          after: values,
        });
        return snapshot({ scope, ...next });
      });
    },

    async history() {
      const rows = await database.select().from(runtimeSettingsAudit)
        .where(eq(runtimeSettingsAudit.scope, scope))
        .orderBy(desc(runtimeSettingsAudit.revision)).limit(20);
      return rows.map((row) => ({
        revision: row.revision,
        actorId: row.actorId,
        createdAt: row.createdAt.toISOString(),
        before: schema.parse(row.before) as Values,
        after: schema.parse(row.after) as Values,
      }));
    },
  };
}

export type SettingsStore<S extends z.ZodObject> = ReturnType<typeof createSettingsStore<S>>;
