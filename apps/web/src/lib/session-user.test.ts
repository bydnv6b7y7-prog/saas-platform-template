import { describe, expect, test } from "bun:test";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";

import { readSessionUser } from "./session-user.server";

const origin = "https://session-render.example.invalid";
const future = new Date(Date.now() + 60_000).toISOString();
const user = { id: "reader", name: "Reader", email: "reader@example.invalid" };
const response = { session: { expiresAt: future, token: "must-not-reach-html" }, user };
const fetcher = (handler: (request: Request) => Promise<Response> | Response): typeof fetch =>
  Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    handler(new Request(input, init)), { preconnect: fetch.preconnect });

describe("request-scoped initial session user", () => {
  test("skips anonymous requests without probing the API", async () => {
    const request = fetcher(() => { throw new Error("Unexpected request"); });
    expect(await readSessionUser(origin, undefined, request)).toBeNull();
  });

  test("forwards the current Cookie and returns only display fields", async () => {
    const request = fetcher((request) => {
      expect(request.headers.get("cookie")).toBe("better-auth.session_token=current");
      expect(request.cache).toBe("no-store");
      expect(request.redirect).toBe("error");
      const url = new URL(request.url);
      expect(url.pathname).toBe("/api/auth/get-session");
      expect(url.searchParams.get("disableRefresh")).toBe("true");
      expect(url.searchParams.get("disableCookieCache")).toBe("true");
      return Response.json({ ...response, user: { ...user, role: "admin", extra: "private" } });
    });
    const result = await readSessionUser(origin, "better-auth.session_token=current", request);
    expect(result).toEqual(user);
    expect(JSON.stringify(result)).not.toContain("must-not-reach-html");
    expect(JSON.stringify(result)).not.toContain("private");
  });

  test("keeps simultaneous request identities separate", async () => {
    const request = fetcher(async (request) => {
      const id = request.headers.get("cookie")!;
      await Promise.resolve();
      return Response.json({ ...response, user: { ...user, id } });
    });
    const [first, second] = await Promise.all([
      readSessionUser(origin, "first-reader", request),
      readSessionUser(origin, "second-reader", request),
    ]);
    expect(first?.id).toBe("first-reader");
    expect(second?.id).toBe("second-reader");
  });

  test("rejects expired and malformed identities", async () => {
    expect(await readSessionUser(origin, "cookie", fetcher(() => Response.json({
      ...response, session: { expiresAt: "2000-01-01T00:00:00Z" },
    })))).toBeNull();
    await expect(readSessionUser(origin, "cookie", fetcher(() => Response.json({ user })))).rejects.toThrow();
  });

  test("distinguishes an unavailable API from a verified anonymous response", async () => {
    expect(await readSessionUser(origin, "cookie", fetcher(() => Response.json(null)))).toBeNull();
    expect(await readSessionUser(origin, "cookie", fetcher(() => new Response(null, { status: 401 })))).toBeNull();
    await expect(readSessionUser(origin, "cookie", fetcher(() => new Response(null, { status: 503 })))).rejects.toThrow("Session could not be checked");
  });

  test("renders from a real signed Cookie on the first read and drops a revoked session", async () => {
    const database = { user: [], account: [], session: [], verification: [] };
    const auth = betterAuth({
      baseURL: origin,
      secret: "isolated-session-render-secret-at-least-thirty-two-characters",
      database: memoryAdapter(database),
      emailAndPassword: { enabled: true },
      advanced: { disableOriginCheck: false, disableCSRFCheck: false },
      logger: { disabled: true },
    });
    const call = (path: string, body: object, cookie?: string) => auth.handler(new Request(`${origin}/api/auth/${path}`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(body),
    }));
    const signUp = await call("sign-up/email", {
      name: user.name, email: user.email, password: "isolated-test-password-123",
    });
    expect(signUp.status).toBe(200);
    const cookie = signUp.headers.getSetCookie().find((value) => value.startsWith("__Secure-better-auth.session_token="))!.split(";", 1)[0]!;
    const request = fetcher((request) => auth.handler(request));
    const initialUser = await readSessionUser(origin, cookie, request);
    expect(initialUser).toMatchObject({ name: user.name, email: user.email });
    expect(Object.keys(initialUser!).sort()).toEqual(["email", "id", "name"]);
    expect((await call("sign-out", {}, cookie)).status).toBe(200);
    expect(await readSessionUser(origin, cookie, request)).toBeNull();
  });
});
