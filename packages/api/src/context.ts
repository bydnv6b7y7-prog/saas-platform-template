import { auth } from "@northwind/auth";
import type { Context as HonoContext } from "hono";

export type CreateContextOptions = {
  context: HonoContext;
};

export async function createContext({ context }: CreateContextOptions) {
  const session = await auth.api.getSession({
    headers: context.req.raw.headers,
  });
  const forwarded = context.req.header("x-forwarded-for");
  // The edge proxy owns x-real-ip in production; prefer it over a client-supplied XFF chain.
  const ip = context.req.header("x-real-ip") ??
    (forwarded ? forwarded.split(",").at(-1)?.trim() : undefined) ??
    "local";
  return {
    auth: null,
    session,
    ip,
  };
}

export type Context = Awaited<ReturnType<typeof createContext>>;
