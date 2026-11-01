import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { adminProcedure, router } from "../index";
import { listAppFeedback, readAppFeedback, setAppFeedbackStatus } from "../app-feedback";
import { SCREENSHOT_VIEW_SECONDS, feedbackScreenshotStorage } from "../feedback-screenshots";

const status = z.enum(["new", "done"]);

/** Feedback from the native app, for administrators only. */
export const appFeedbackRouter = router({
  list: adminProcedure.input(z.strictObject({
    status: status.optional(),
    limit: z.number().int().min(1).max(100).default(30),
    // Infinite queries send `cursor: null` for the first page, and a direction.
    cursor: z.strictObject({ createdAt: z.iso.datetime(), id: z.uuid() }).nullish(),
    direction: z.enum(["forward", "backward"]).optional(),
  })).query(({ input }) => listAppFeedback({ status: input.status, limit: input.limit, cursor: input.cursor ?? undefined })),
  detail: adminProcedure.input(z.strictObject({ id: z.uuid() })).query(async ({ input }) => {
    const feedback = await readAppFeedback(input.id);
    if (!feedback) throw new TRPCError({ code: "NOT_FOUND", message: "Feedback not found" });
    const { screenshotKey, ...rest } = feedback;
    // A short-lived link to the one object; the key and credentials stay here.
    const screenshotUrl = screenshotKey && feedbackScreenshotStorage
      ? await feedbackScreenshotStorage.presignDownload(screenshotKey, SCREENSHOT_VIEW_SECONDS)
      : null;
    return { ...rest, screenshotUrl, screenshotStored: screenshotKey !== null };
  }),
  setStatus: adminProcedure.input(z.strictObject({ id: z.uuid(), status })).mutation(async ({ ctx, input }) => {
    const updated = await setAppFeedbackStatus({ ...input, actorId: ctx.session.user.id });
    if (!updated) throw new TRPCError({ code: "NOT_FOUND", message: "Feedback not found" });
    return updated;
  }),
});
