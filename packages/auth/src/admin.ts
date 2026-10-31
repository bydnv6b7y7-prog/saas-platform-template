import { env } from "@northwind/env/server";
import {
  APIError,
  createAuthMiddleware,
  getAuthoritativeSessionFromCtx,
} from "better-auth/api";
import { admin } from "better-auth/plugins/admin";

import {
  adminCreateUserSchema,
  adminUpdateUserSchema,
} from "./admin-user-contract";

type AdminPrincipal = {
  id: string;
  role?: string | null;
};

export function createAdminAccess(
  value: string | null | undefined,
  options: { onDeleteUser?: (userId: string) => Promise<unknown> } = {},
) {
  const bootstrapUserIds = new Set(
    (value ?? "")
      .split(",")
      .map((userId) => userId.trim())
      .filter(Boolean),
  );

  const allows = (user: AdminPrincipal): boolean =>
    bootstrapUserIds.has(user.id) ||
    (user.role ?? "").split(",").includes("admin");

  return {
    allows,
    betterAuthPlugin() {
      const plugin = admin({ adminUserIds: [...bootstrapUserIds] });
      // Admin removal runs the same account-deletion routine as self-service
      // (Stripe cancel-at-period-end, conversation history, PostHog, email)
      // and short-circuits with the stock success shape. Omitted option keeps
      // the stock better-auth delete semantics untouched.
      const removeUserHook = options.onDeleteUser
        ? [
            {
              matcher: (context: { path?: string }) =>
                context.path === "/admin/remove-user",
              handler: createAuthMiddleware(async (context) => {
                const session = await getAuthoritativeSessionFromCtx(context);
                if (!session)
                  throw new APIError("UNAUTHORIZED", {
                    message: "Sign in to manage users.",
                  });
                if (!allows(session.user))
                  throw new APIError("FORBIDDEN", {
                    message: "Administrator access is required.",
                  });
                const body = context.body as { userId?: unknown } | undefined;
                if (typeof body?.userId !== "string" || !body.userId.trim())
                  throw new APIError("BAD_REQUEST", {
                    code: "INVALID_ADMIN_USER_INPUT",
                    message: "Choose a user.",
                  });
                if (body.userId === session.user.id)
                  throw new APIError("BAD_REQUEST", {
                    code: "CANNOT_REMOVE_YOURSELF",
                    message: "You cannot remove your own account.",
                  });
                const target = await context.context.internalAdapter.findUserById(
                  body.userId,
                );
                if (!target)
                  throw new APIError("NOT_FOUND", {
                    message: "User not found.",
                  });
                await options.onDeleteUser!(body.userId);
                return context.json({ success: true });
              }),
            },
          ]
        : [];
      return {
        ...plugin,
        hooks: {
          ...plugin.hooks,
          before: [
            ...removeUserHook,
            {
              matcher: (context: { path?: string }) =>
                [
                  "/admin/create-user",
                  "/admin/update-user",
                  "/admin/set-role",
                ].includes(context.path ?? ""),
              handler: createAuthMiddleware(async (context) => {
                // Check the server-side session before inspecting any target account.
                const session = await getAuthoritativeSessionFromCtx(context);
                if (!session)
                  throw new APIError("UNAUTHORIZED", {
                    message: "Sign in to manage users.",
                  });
                if (!allows(session.user))
                  throw new APIError("FORBIDDEN", {
                    message: "Administrator access is required.",
                  });

                const invalid = (message: string): never => {
                  throw new APIError("BAD_REQUEST", {
                    code: "INVALID_ADMIN_USER_INPUT",
                    message,
                  });
                };
                const body = context.body;
                if (context.path === "/admin/create-user") {
                  const parsed = adminCreateUserSchema.safeParse({
                    ...body?.data,
                    name: body?.name,
                    email: body?.email,
                    password: body?.password,
                    role: body?.role ?? body?.data?.role ?? "user",
                    emailVerified: body?.data?.emailVerified ?? false,
                  });
                  if (!parsed.success)
                    return invalid(parsed.error.issues[0]!.message);
                  const { emailVerified, ...fields } = parsed.data;
                  return {
                    context: { body: { ...fields, data: { emailVerified } } },
                  };
                }

                if (typeof body?.userId !== "string" || !body.userId.trim())
                  return invalid("Choose a user.");
                const parsed = adminUpdateUserSchema.safeParse(
                  context.path === "/admin/set-role"
                    ? { role: body.role }
                    : body.data,
                );
                if (!parsed.success)
                  return invalid(parsed.error.issues[0]!.message);
                const changes = parsed.data;
                if (
                  changes.role &&
                  body.userId === session.user.id &&
                  !allows({ id: session.user.id, role: changes.role })
                ) {
                  throw new APIError("BAD_REQUEST", {
                    code: "CANNOT_REMOVE_OWN_ADMIN_ROLE",
                    message: "You cannot remove your own administrator access.",
                  });
                }
                if (context.path === "/admin/update-user") {
                  // Verification belongs to the current email; never inherit it for a new address.
                  if (changes.email && changes.emailVerified === undefined) {
                    const target =
                      await context.context.internalAdapter.findUserById(
                        body.userId,
                      );
                    if (target && changes.email !== target.email)
                      changes.emailVerified = false;
                  }
                  context.body.data = changes;
                }
              }),
            },
          ],
        },
      };
    },
  };
}

/** Shared authorization semantics for Better Auth and product Admin routes. */
export const adminAccess = createAdminAccess(env.ADMIN_USER_IDS);
