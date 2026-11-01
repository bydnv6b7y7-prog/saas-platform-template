import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, sessionMiddleware } from "better-auth/api";
import { z } from "zod";
import { ERROR_MESSAGES, asAppStoreError } from "./errors";
import type { AppStoreService } from "./service";

const MAX_BODY = 64 * 1024;
const signedBody = z.object({ signedTransaction: z.string().min(1).max(MAX_BODY) }).strict();
const APP_STORE_ERROR_CODES = Object.fromEntries(Object.entries(ERROR_MESSAGES).map(([code, message]) => [code, { code, message }])) as {
  [K in keyof typeof ERROR_MESSAGES]: { code: K; message: typeof ERROR_MESSAGES[K] };
};
async function run<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error) {
    const failure = asAppStoreError(error);
    throw new APIError(failure.status as 400 | 401 | 409 | 422 | 503, { message: failure.message, code: failure.code });
  }
}
async function checkBody(request: Request): Promise<Response | null> {
  const fail = (status: number) => Response.json({ code: "INVALID_SIGNED_DATA", message: ERROR_MESSAGES.INVALID_SIGNED_DATA }, { status, headers: { "Cache-Control": "no-store" } });
  const type = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (request.body === null) return null; // account-token also accepts an empty POST.
  if (type !== "application/json") return fail(415);
  if (Number(request.headers.get("content-length")) > MAX_BODY) return fail(413);
  const reader = request.clone().body!.getReader();
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        for (;;) {
          const part = await reader.read();
          if (part.done) return;
          size += part.value.byteLength;
          if (size > MAX_BODY) throw new Error("body too large");
        }
      })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("body timeout")), 10_000); }),
    ]);
    return null;
  } catch {
    void reader.cancel().catch(() => {});
    void request.body.cancel().catch(() => {});
    return fail(size > MAX_BODY ? 413 : 408);
  } finally { clearTimeout(timer); }
}

export function createAppStorePlugin(service: Pick<AppStoreService, "accountToken" | "sync" | "status" | "accept" | "maintain">) {
  return {
    id: "app-store",
    version: "0.1.0",
    $ERROR_CODES: APP_STORE_ERROR_CODES,
    init(ctx) {
      const skip = ctx.skipOriginCheck;
      return {
        context: { skipOriginCheck: skip === true ? true : [...new Set([...(Array.isArray(skip) ? skip : []), "/app-store/notifications"])] },
        options: { rateLimit: { ...ctx.options.rateLimit, customRules: { ...ctx.options.rateLimit?.customRules, "/app-store/notifications": false } } },
      };
    },
    rateLimit: [
      { window: 60, max: 20, pathMatcher: path => path === "/app-store/account-token" },
      { window: 60, max: 10, pathMatcher: path => path === "/app-store/sync" || path === "/app-store/restore" },
    ],
    async onRequest(request, ctx) {
      const path = new URL(request.url).pathname;
      const base = new URL(ctx.baseURL).pathname.replace(/\/$/, "");
      if (!path.startsWith(`${base}/app-store/`) || request.method !== "POST") return;
      const response = await checkBody(request);
      if (response) return { response };
    },
    endpoints: {
      appStoreAccountToken: createAuthEndpoint("/app-store/account-token", {
        method: "POST", body: z.object({}).strict().default({}), use: [sessionMiddleware],
      }, async ctx => {
        ctx.setHeader("Cache-Control", "no-store");
        return ctx.json(await run(() => service.accountToken(ctx.context.session.user.id)));
      }),
      appStoreSync: createAuthEndpoint("/app-store/sync", {
        method: "POST", body: signedBody, use: [sessionMiddleware],
      }, async ctx => {
        ctx.setHeader("Cache-Control", "no-store");
        return ctx.json(await run(() => service.sync(ctx.context.session.user.id, ctx.body.signedTransaction)));
      }),
      appStoreRestore: createAuthEndpoint("/app-store/restore", {
        method: "POST", body: signedBody, use: [sessionMiddleware],
      }, async ctx => {
        ctx.setHeader("Cache-Control", "no-store");
        return ctx.json(await run(() => service.sync(ctx.context.session.user.id, ctx.body.signedTransaction, true)));
      }),
      appStoreStatus: createAuthEndpoint("/app-store/status", {
        method: "GET", query: z.object({ environment: z.enum(["Production", "Sandbox"]).default("Production") }).strict(), use: [sessionMiddleware],
      }, async ctx => {
        ctx.setHeader("Cache-Control", "no-store");
        return ctx.json(await run(() => service.status(ctx.context.session.user.id, ctx.query.environment)));
      }),
      appStoreNotifications: createAuthEndpoint("/app-store/notifications", {
        method: "POST", body: z.object({ signedPayload: z.string().min(1).max(MAX_BODY) }).strict(),
      }, async ctx => ctx.json(await run(() => service.accept(ctx.body.signedPayload)))),
      runAppStoreMaintenance: createAuthEndpoint.serverOnly({ method: "POST" }, async () => {
        await service.maintain();
        return { complete: true };
      }),
    },
  } satisfies BetterAuthPlugin;
}
