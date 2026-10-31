import { db } from "@northwind/db";
import { z } from "zod";

import { adminProcedure, router } from "../index";
import { createSettingsStore, type SettingsDefinition } from "../settings-store";

/** Admin overview / update / history for one settings scope; mount it under `config.<name>`. */
export function createSettingsRouter<S extends z.ZodObject>(
  definition: SettingsDefinition<S>,
  store = createSettingsStore(db, definition),
) {
  return router({
    overview: adminProcedure.query(async () => ({
      ...await store.read(),
      defaults: definition.defaults as z.infer<S>,
    })),
    update: adminProcedure.input(z.strictObject({
      expectedRevision: z.number().int().min(0).max(2_147_483_646),
      values: definition.schema as unknown as z.ZodType<z.infer<S>, z.infer<S>>,
    })).mutation(({ ctx, input }) => store.update({
      expectedRevision: input.expectedRevision,
      values: input.values,
      actorId: ctx.session.user.id,
    })),
    history: adminProcedure.query(() => store.history()),
  });
}
