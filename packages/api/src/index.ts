import { adminAccess } from "@northwind/auth/admin";
import { initTRPC, TRPCError } from "@trpc/server";

import type { Context } from "./context";

// errorFormatter：线上不向客户端泄漏堆栈（此前错误响应带 stack，上线前修复）
export const t = initTRPC.context<Context>().create({
  errorFormatter({ shape }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        stack: undefined,
      },
    };
  },
});

export const router = t.router;

export const publicProcedure = t.procedure;

const requireSession = t.middleware(({ ctx, next }) => {
  if (!ctx.session) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Authentication required",
      cause: "No session",
    });
  }
  return next({
    ctx: {
      ...ctx,
      session: ctx.session,
    },
  });
});

export const protectedProcedure = publicProcedure.use(requireSession);

function assertAdminAccess(user: NonNullable<Context["session"]>["user"]): void {
  if (adminAccess.allows(user)) return;
  throw new TRPCError({
    code: "FORBIDDEN",
    message: "Administrator access required",
  });
}

export const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  assertAdminAccess(ctx.session.user);
  return next({ ctx });
});
