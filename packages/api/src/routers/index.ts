import { publicProcedure } from "../index";
import { appFeedbackRouter } from "./app-feedback";

export { platformConfigRouters } from "./config";

/** Platform procedures. The product composes the final appRouter (packages/product/src/router.ts). */
export const platformRouters = {
  healthCheck: publicProcedure.query(() => {
    return "OK";
  }),
  appFeedback: appFeedbackRouter,
};
