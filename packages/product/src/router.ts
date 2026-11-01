import { protectedProcedure, publicProcedure, router } from "@northwind/api";
import { platformConfigRouters, platformRouters } from "@northwind/api/routers/index";
import { z } from "zod";

import { notesRouter } from "./routers/notes";

/** Example product procedures; replace with your own routers. */
const exampleRouter = router({
  hello: publicProcedure
    .input(z.object({ name: z.string().trim().min(1).max(80).optional() }))
    .query(({ input }) => ({ message: `Hello, ${input.name ?? "world"}!` })),
  whoami: protectedProcedure.query(({ ctx }) => ({ id: ctx.session.user.id, email: ctx.session.user.email })),
});

/** Composition root: platform procedures plus this product's procedures. */
export const appRouter = router({
  ...platformRouters,
  config: router({ ...platformConfigRouters }),
  example: exampleRouter,
  notes: notesRouter,
});
export type AppRouter = typeof appRouter;
