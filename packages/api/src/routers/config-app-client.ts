import { APP_CLIENT_CONFIG_DEFAULTS, appClientConfigSchema } from "@northwind/env/app-client-config";
import { z } from "zod";

import { adminProcedure, router } from "../index";
import { readAppClientConfig, readAppClientConfigHistory, updateAppClientConfig } from "../app-client-config";
import { feedbackScreenshotStorage } from "../feedback-screenshots";

/** The native app's review and feedback settings (docs/app-feedback-rating.md). */
export const appClientConfigRouter = router({
  overview: adminProcedure.query(async () => ({
    ...await readAppClientConfig(),
    defaults: APP_CLIENT_CONFIG_DEFAULTS,
    /** Screenshots need R2; without it the app is told none are allowed. */
    screenshotStorageConfigured: feedbackScreenshotStorage !== null,
  })),
  update: adminProcedure.input(z.strictObject({
    expectedRevision: z.number().int().min(0).max(2_147_483_646),
    values: appClientConfigSchema,
  })).mutation(({ ctx, input }) => updateAppClientConfig({
    ...input,
    actorId: ctx.session.user.id,
  })),
  history: adminProcedure.query(() => readAppClientConfigHistory()),
});
