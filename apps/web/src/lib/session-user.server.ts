import { z } from "zod";

import { sessionUserSchema, type AppUser } from "./session-user";

const sessionResponseSchema = z.object({
  session: z.object({ expiresAt: z.coerce.date() }),
  user: sessionUserSchema,
});

/** Request-scoped display data. Never serialize session tokens into the page. */
export async function readSessionUser(
  apiBaseURL: string,
  cookie: string | undefined,
  request: typeof fetch = fetch,
): Promise<AppUser | null> {
  if (!cookie) return null;

  const url = new URL("/api/auth/get-session", apiBaseURL);
  // Browser useSession retains ownership of renewal and its Set-Cookie response.
  url.searchParams.set("disableRefresh", "true");
  url.searchParams.set("disableCookieCache", "true");
  const response = await request(url, {
    headers: { Cookie: cookie, Accept: "application/json" },
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error("Session could not be checked");

  const body: unknown = await response.json();
  if (body === null) return null;
  const session = sessionResponseSchema.parse(body);
  if (session.session.expiresAt.getTime() <= Date.now()) return null;
  return session.user;
}
