import { appStoreAdmin, appStoreTestNotificationInput } from "../app-store-admin";
import { adminProcedure, router } from "../index";

/** Diagnostics remain available with Market AI or App Store processing disabled. */
export function createAppStoreConfigRouter(service: typeof appStoreAdmin = appStoreAdmin) {
  return router({
    overview: adminProcedure.query(() => service.overview()),
    testRequest: adminProcedure.input(appStoreTestNotificationInput)
      .query(({ ctx, input }) => service.testRequest({ ...input, actorId: ctx.session.user.id })),
    testNotification: adminProcedure.input(appStoreTestNotificationInput)
      .mutation(({ ctx, input }) => service.testNotification({ ...input, actorId: ctx.session.user.id })),
  });
}

export const appStoreConfigRouter = createAppStoreConfigRouter();
