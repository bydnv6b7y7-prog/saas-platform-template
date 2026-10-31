import { describe, expect, test } from "bun:test";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { exportPKCS8, generateKeyPair } from "jose";
import { createSocialProviderConfiguration } from "./social-providers";

const credentials = { email: "native-fixture@example.invalid", password: "FixtureOnlyPass123!" };
const day = 86_400_000;

function fixture(baseURL = "http://localhost:3999", socialProviders?: BetterAuthOptions["socialProviders"]) {
  const database = { user: [], session: [], account: [], verification: [] };
  const auth = betterAuth({
    database: memoryAdapter(database),
    socialProviders,
    secret: "isolated-test-secret-at-least-thirty-two-characters",
    baseURL,
    emailAndPassword: { enabled: true },
    advanced: {
      // Better Auth otherwise skips origin checks in its test environment.
      disableOriginCheck: false,
      disableCSRFCheck: false,
      backgroundTasks: { handler: (task) => task.catch(() => {}) },
    },
    logger: { disabled: true },
  });
  const call = (path: string, body?: object, cookie?: string, origin: string | null = baseURL) =>
    auth.handler(new Request(`${baseURL}/api/auth/${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        "Content-Type": "application/json",
        ...(origin ? { Origin: origin } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }));
  return { auth, call, database };
}

function sessionCookie(response: Response): string {
  const cookie = response.headers.getSetCookie().find((value) => /^(?:__Secure-)?better-auth\.session_token=/.test(value));
  if (!cookie) throw new Error("Expected Better Auth session Cookie");
  return cookie.split(";", 1)[0]!;
}

describe("native Cookie auth protocol", () => {
  test("email Cookie sessions restore, update and revoke while preserving CSRF checks", async () => {
    const { call } = fixture();
    const signup = await call("sign-up/email", { ...credentials, name: "Native fixture", rememberMe: true });
    expect(signup.status).toBe(200);
    expect(signup.headers.get("set-auth-token")).toBeNull();
    const initial = await signup.json() as { token: string; user: { id: string } };
    const cookie = sessionCookie(signup);
    expect(cookie).not.toBe(`better-auth.session_token=${initial.token}`);

    const restored = await call("get-session", undefined, cookie);
    expect(restored.status).toBe(200);
    expect((await restored.json() as { user: { id: string } }).user.id).toBe(initial.user.id);
    expect(await (await call("get-session")).json()).toBeNull();
    expect(await (await call("get-session", undefined, `better-auth.session_token=${initial.token}`)).json()).toBeNull();
    expect(await (await call("get-session", undefined, `${cookie}tampered`)).json()).toBeNull();

    expect((await call("update-user", { name: "Rejected" }, cookie, null)).status).toBe(403);
    expect((await call("update-user", { name: "Rejected" }, cookie, "https://untrusted.example.invalid")).status).toBe(403);
    expect((await call("update-user", { name: "Renamed fixture" }, cookie)).status).toBe(200);
    expect((await (await call("get-session", undefined, cookie)).json() as { user: { name: string } }).user.name)
      .toBe("Renamed fixture");

    const logout = await call("sign-out", {}, cookie);
    expect(logout.status).toBe(200);
    expect(logout.headers.getSetCookie().some((value) => value.includes("session_token=") && value.includes("Max-Age=0"))).toBe(true);
    expect(await (await call("get-session", undefined, cookie)).json()).toBeNull();
    expect((await call("sign-in/email", { ...credentials, password: "IncorrectFixturePassword" })).status).toBe(401);
    const login = await call("sign-in/email", credentials);
    expect(login.status).toBe(200);
    expect(sessionCookie(login)).toBeTruthy();
    expect(login.headers.get("set-auth-token")).toBeNull();
  });

  test("get-session renews an eligible session and cannot revive an expired one", async () => {
    const { auth, call } = fixture();
    const signup = await call("sign-up/email", { ...credentials, name: "Expiry fixture" });
    const cookie = sessionCookie(signup);
    const { token } = await signup.json() as { token: string };
    const context = await auth.$context;
    expect(context.sessionConfig.expiresIn).toBe(7 * 86_400);
    expect(context.sessionConfig.updateAge).toBe(86_400);
    // Age only this isolated DB record; do not change global time or the existing product database.
    await context.internalAdapter.updateSession(token, {
      expiresAt: new Date(Date.now() + 5 * day),
      updatedAt: new Date(Date.now() - 2 * day),
    });
    const renewal = await call("get-session", undefined, cookie);
    expect(renewal.status).toBe(200);
    const renewed = await renewal.json() as { session: { expiresAt: string } };
    expect(new Date(renewed.session.expiresAt).getTime()).toBeGreaterThan(Date.now() + 6.9 * day);
    expect(sessionCookie(renewal)).toBe(cookie);
    await context.internalAdapter.updateSession(token, { expiresAt: new Date(Date.now() - day) });
    const expired = await call("get-session", undefined, cookie);
    expect(await expired.json()).toBeNull();
    expect(expired.headers.getSetCookie().some((value) => value.includes("Max-Age=0"))).toBe(true);
  });

  test("HTTPS sessions use Secure, HttpOnly and SameSite cookies", async () => {
    const { call } = fixture("https://native-fixture.example.invalid");
    const signup = await call("sign-up/email", { ...credentials, name: "Secure fixture" });
    expect(signup.status).toBe(200);
    expect(sessionCookie(signup)).toStartWith("__Secure-better-auth.session_token=");
    const header = signup.headers.getSetCookie().find((value) => value.startsWith("__Secure-better-auth.session_token="))!;
    expect(header).toMatch(/; Secure(?:;|$)/);
    expect(header).toMatch(/; HttpOnly(?:;|$)/);
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Max-Age=604800");
  });

  test("native providers reject unverified ID tokens without creating accounts or sessions", async () => {
    const { call, database } = fixture("http://localhost:3999", {
      google: { clientId: ["fixture-web", "fixture-ios"], clientSecret: "fixture-only-secret" },
      apple: { clientId: "fixture-web", audience: ["fixture-web", "fixture-ios"], clientSecret: "fixture-only-secret" },
    });
    // Malformed JWTs fail before any provider JWKS lookup; no external OAuth requests.
    for (const provider of ["apple", "google"]) {
      const response = await call("sign-in/social", {
        provider,
        idToken: { token: "not-a-signed-jwt", nonce: "untrusted-nonce" },
        subject: "untrusted-subject",
        email: "untrusted@example.invalid",
      });
      expect(response.status).toBe(401);
      expect(response.headers.getSetCookie().some((value) => value.includes("session_token="))).toBe(false);
    }
    expect(database.user).toHaveLength(0);
    expect(database.session).toHaveLength(0);
    expect(database.account).toHaveLength(0);
  });

  test("native Apple audience preserves the web Service ID", async () => {
    const { privateKey } = await generateKeyPair("ES256", { extractable: true });
    const pem = await exportPKCS8(privateKey);
    const config = createSocialProviderConfiguration({
      appleClientId: "com.example.web",
      appleAppBundleIdentifier: "com.example.native",
      appleTeamId: "TEAM123456",
      appleKeyId: "KEY1234567",
      applePrivateKeyBase64: Buffer.from(pem).toString("base64"),
    });
    const apple = config.providers.apple;
    if (typeof apple !== "function") throw new Error("Expected Apple provider configuration");
    const options = await apple();
    expect(options.clientId).toBe("com.example.web");
    expect(options.audience).toEqual(["com.example.web", "com.example.native"]);
    expect(createSocialProviderConfiguration({ appleAppBundleIdentifier: "com.example.native" }).enabledProviderIds).toEqual([]);
  });

  test("native Google audience is additive and keeps the web client first", () => {
    const value = createSocialProviderConfiguration({
      googleClientId: "web-client.apps.googleusercontent.com",
      googleIosClientId: "ios-client.apps.googleusercontent.com",
      googleClientSecret: "test-only-client-secret",
    });
    expect(value.providers.google).toMatchObject({
      clientId: ["web-client.apps.googleusercontent.com", "ios-client.apps.googleusercontent.com"],
    });
    expect(createSocialProviderConfiguration({ googleIosClientId: "ios-client" }).enabledProviderIds).toEqual([]);
  });
});
