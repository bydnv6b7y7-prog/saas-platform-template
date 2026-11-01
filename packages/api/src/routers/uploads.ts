import { getUserBillingStatus } from "@northwind/auth";
import { adminAccess } from "@northwind/auth/admin";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { protectedProcedure, router } from "../index";
import { UploadRefused, userObjects, type Plan, type UserStoragePurpose } from "../user-objects";

/** Administrators and paying subscribers get the Pro quota; everyone else Free. */
async function planOf(user: { id: string; role?: string | null }): Promise<Plan> {
  if (adminAccess.allows(user)) return "pro";
  return (await getUserBillingStatus(user.id)).subscription?.grantsAccess ? "pro" : "free";
}

const id = z.object({ id: z.uuid() });

/**
 * Browser-direct uploads for one purpose: usage, reserve (signed PUT), confirm,
 * view (signed GET). Mount it in the product router, e.g. `notes: { attachments: createUploadRouter(purpose) }`;
 * the product links confirmed ids to its own rows and calls `userObjects.release` when it drops them.
 */
export function createUploadRouter(purpose: UserStoragePurpose, store = userObjects) {
  return router({
    usage: protectedProcedure.query(async ({ ctx }) =>
      store.usage(ctx.session.user.id, purpose, await planOf(ctx.session.user))),
    reserve: protectedProcedure.input(z.strictObject({
      contentType: z.string().max(100),
      byteLength: z.number().int().positive(),
    })).mutation(async ({ ctx, input }) => {
      try {
        return await store.reserve({ userId: ctx.session.user.id, plan: await planOf(ctx.session.user), purpose, ...input });
      } catch (error) {
        if (!(error instanceof UploadRefused)) throw error;
        throw new TRPCError({
          code: error.reason === "unavailable" ? "PRECONDITION_FAILED" : error.reason === "quota" ? "FORBIDDEN" : "BAD_REQUEST",
          message: error.reason,
          cause: error,
        });
      }
    }),
    confirm: protectedProcedure.input(id).mutation(async ({ ctx, input }) => {
      const object = await store.confirm(ctx.session.user.id, purpose, input.id);
      if (!object) throw new TRPCError({ code: "BAD_REQUEST", message: "not_uploaded" });
      return object;
    }),
    viewUrl: protectedProcedure.input(id).query(async ({ ctx, input }) => {
      const url = await store.viewUrl(ctx.session.user.id, purpose, input.id);
      if (!url) throw new TRPCError({ code: "NOT_FOUND" });
      return { url };
    }),
  });
}
