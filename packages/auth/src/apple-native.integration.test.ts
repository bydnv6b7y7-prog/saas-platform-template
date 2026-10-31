import { beforeAll, describe, expect, spyOn, test } from "bun:test";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { exportJWK, exportPKCS8, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { createHash } from "node:crypto";
import { createSocialProviderConfiguration } from "./social-providers";

const origin = "https://native-apple.example.invalid";
const bundleId = "com.example.native";
const subject = "isolated-apple-subject";
const email = "isolated-fixture@privaterelay.appleid.com";
const nonce = "isolated-native-request-nonce";
let signingKey: CryptoKey;
let unrelatedKey: CryptoKey;
let publicJwk: Awaited<ReturnType<typeof exportJWK>>;
let providers: ReturnType<typeof createSocialProviderConfiguration>["providers"];
let nativeProviders: typeof providers;

beforeAll(async () => {
  const keys = await generateKeyPair("RS256", { extractable: true });
  signingKey = keys.privateKey;
  unrelatedKey = (await generateKeyPair("RS256")).privateKey;
  publicJwk = { ...await exportJWK(keys.publicKey), kid: "isolated-apple-key", alg: "RS256", use: "sig" };
  const clientKeys = await generateKeyPair("ES256", { extractable: true });
  const credentials = {
    appleAppBundleIdentifier: bundleId,
    appleTeamId: "TEAM123456",
    appleKeyId: "KEY1234567",
    applePrivateKeyBase64: Buffer.from(await exportPKCS8(clientKeys.privateKey)).toString("base64"),
  };
  providers = createSocialProviderConfiguration({ ...credentials, appleClientId: "com.example.web" }).providers;
  nativeProviders = createSocialProviderConfiguration({ ...credentials, appleClientId: bundleId }).providers;
});

async function token(claims: JWTPayload = {}, key = signingKey) {
  const now = Math.floor(Date.now() / 1_000);
  return new SignJWT({
    iss: "https://appleid.apple.com", aud: bundleId, sub: subject,
    iat: now, exp: now + 300, email, email_verified: "true", is_private_email: "true",
    nonce: createHash("sha256").update(nonce).digest("hex"),
    ...claims,
  }).setProtectedHeader({ alg: "RS256", kid: "isolated-apple-key" }).sign(key);
}

function fixture(socialProviders = providers) {
  const database: Record<"user" | "session" | "account" | "verification", Record<string, unknown>[]> = {
    user: [], session: [], account: [], verification: [],
  };
  const auth = betterAuth({
    baseURL: origin,
    secret: "isolated-apple-test-secret-at-least-thirty-two-characters",
    database: memoryAdapter(database),
    socialProviders,
    emailAndPassword: { enabled: true, requireEmailVerification: true },
    advanced: { disableOriginCheck: false, disableCSRFCheck: false },
    logger: { disabled: true },
  });
  const call = (path: string, body?: object, cookie?: string) => auth.handler(new Request(`${origin}/api/auth/${path}`, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", Origin: origin, ...(cookie ? { Cookie: cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }));
  return { auth, call, database };
}

// Only the external JWKS response is substituted. Better Auth still verifies
// the actual RSA signature, claims and nonce, then persists users and sessions.
async function withAppleKeys(run: (value: ReturnType<typeof fixture>) => Promise<void>, socialProviders = providers) {
  const jwksFetch: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== "https://appleid.apple.com/auth/keys") throw new Error("Unexpected external request in Apple fixture");
    return Response.json({ keys: [publicJwk] });
  }, { preconnect: globalThis.fetch.preconnect });
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(jwksFetch);
  try { await run(fixture(socialProviders)); } finally { fetchMock.mockRestore(); }
}

function cookie(response: Response) {
  const value = response.headers.getSetCookie().find(header => header.startsWith("__Secure-better-auth.session_token="));
  expect(value).toBeDefined();
  return value!.split(";", 1)[0]!;
}

describe("native Apple signed-token login", () => {
  test("signs in with the App ID as client ID without a web Services ID", async () => {
    await withAppleKeys(async ({ call }) => {
      const login = await call("sign-in/social", { provider: "apple", idToken: { token: await token(), nonce } });
      expect(login.status).toBe(200);
      expect(await login.json()).toMatchObject({ user: { email, emailVerified: true } });
      expect(await (await call("get-session", undefined, cookie(login))).json()).toMatchObject({ user: { email } });
    }, nativeProviders);
  });

  test("accepts the native audience and hashed nonce, restores and revokes the resulting session", async () => {
    await withAppleKeys(async ({ call, database }) => {
      const login = await call("sign-in/social", {
        provider: "apple", subject: "untrusted-client-subject", email: "untrusted@example.invalid",
        idToken: { token: await token(), nonce, user: { name: { firstName: "Native", lastName: "Reader" } } },
      });
      expect(login.status).toBe(200);
      const result = await login.json() as { user: { id: string; name: string; email: string; emailVerified: boolean } };
      expect(result.user).toMatchObject({ name: "Native Reader", email, emailVerified: true });
      expect(database.account).toHaveLength(1);
      expect(database.account[0]).toMatchObject({ accountId: subject, providerId: "apple", userId: result.user.id });
      const sessionCookie = cookie(login);
      expect(await (await call("get-session", undefined, sessionCookie)).json()).toMatchObject({ user: { id: result.user.id } });
      expect((await call("sign-out", {}, sessionCookie)).status).toBe(200);
      expect(await (await call("get-session", undefined, sessionCookie)).json()).toBeNull();
    });
  });

  test("repeated authorization without a name keeps the same Apple account and existing name", async () => {
    await withAppleKeys(async ({ call, database }) => {
      const first = await call("sign-in/social", {
        provider: "apple", idToken: { token: await token(), nonce, user: { name: { firstName: "Native", lastName: "Reader" } } },
      });
      expect(first.status).toBe(200);
      const initial = await first.json() as { user: { id: string } };
      const repeated = await call("sign-in/social", { provider: "apple", idToken: { token: await token(), nonce } });
      expect(repeated.status).toBe(200);
      expect(await repeated.json()).toMatchObject({ user: { id: initial.user.id, name: "Native Reader", email } });
      expect(database.user).toHaveLength(1);
      expect(database.account).toHaveLength(1);
    });
  });

  test("links a verified Apple mailbox to the existing verified email account", async () => {
    await withAppleKeys(async ({ auth, call, database }) => {
      const signup = await call("sign-up/email", { email, password: "IsolatedFixturePass123!", name: "Existing Reader" });
      expect(signup.status).toBe(200);
      const existing = await signup.json() as { user: { id: string } };
      await (await auth.$context).internalAdapter.updateUser(existing.user.id, { emailVerified: true });
      const login = await call("sign-in/social", { provider: "apple", idToken: { token: await token(), nonce } });
      expect(login.status).toBe(200);
      expect(await login.json()).toMatchObject({ user: { id: existing.user.id } });
      expect(database.user).toHaveLength(1);
      expect(database.account).toHaveLength(2);
    });
  });

  test.each([
    { label: "wrong bundle ID", claims: { aud: "com.example.unrelated" } },
    { label: "wrong issuer", claims: { iss: "https://untrusted.example.invalid" } },
    { label: "expired token", claims: { exp: 1 } },
    { label: "mismatched nonce", claims: { nonce: "different-nonce" } },
    { label: "missing nonce claim", claims: { nonce: undefined } },
  ])("rejects $label without creating a user or session", async ({ claims }) => {
    await withAppleKeys(async ({ call, database }) => {
      const response = await call("sign-in/social", { provider: "apple", idToken: { token: await token(claims), nonce } });
      expect(response.status).toBe(401);
      expect(response.headers.getSetCookie()).toHaveLength(0);
      expect(database.user).toHaveLength(0);
      expect(database.account).toHaveLength(0);
      expect(database.session).toHaveLength(0);
    });
  });

  test("rejects a token signed by a different key", async () => {
    await withAppleKeys(async ({ call, database }) => {
      const response = await call("sign-in/social", { provider: "apple", idToken: { token: await token({}, unrelatedKey), nonce } });
      expect(response.status).toBe(401);
      expect(response.headers.getSetCookie()).toHaveLength(0);
      expect(database.user).toHaveLength(0);
      expect(database.account).toHaveLength(0);
      expect(database.session).toHaveLength(0);
    });
  });
});
