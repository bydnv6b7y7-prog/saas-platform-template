import { describe, expect, test } from "bun:test";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { createAuthClient } from "better-auth/client";
import { createAppStorePlugin } from "./plugin";
import { appStoreClient } from "./client";
import { AppStoreError } from "./errors";
import { startAppStoreMaintenance, type AppStoreService } from "./service";

const baseURL = "http://localhost:3998";
let fixtureNumber = 0;
function fixture(enabled = true) {
  const ip = `198.18.0.${++fixtureNumber}`;
  const seen: Array<{ action: string; userId?: string; restore?: boolean }> = [];
  let failure: AppStoreError | undefined;
  let maintenance = 0;
  const service: Pick<AppStoreService, "accountToken" | "sync" | "status" | "accept" | "maintain"> = {
    async accountToken(userId: string) { seen.push({ action: "accountToken", userId }); return { appAccountToken: "00112233-4455-6677-8899-aabbccddeeff" }; },
    async sync(userId: string, _signed: string, restore = false) {
      seen.push({ action: "sync", userId, restore });
      if (failure) throw failure;
      return { binding: "bound", tokenSyncState: "pending", status: { environment: "Production", asOf: new Date().toISOString(), entitlements: [] } };
    },
    async status(userId, env) { seen.push({ action: "status", userId }); if (env !== "Production") throw new AppStoreError("INVALID_ENVIRONMENT"); return { environment: env, asOf: new Date().toISOString(), entitlements: [] }; },
    async accept(signed: string) { seen.push({ action: "accept" }); if (signed !== "verified") throw new AppStoreError("INVALID_SIGNED_DATA"); return { accepted: true }; },
    async maintain() { maintenance++; },
  };
  const auth = betterAuth({
    database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
    baseURL, secret: "isolated-plugin-test-secret-with-more-than-thirty-two-characters",
    emailAndPassword: { enabled: true }, plugins: enabled ? [createAppStorePlugin(service)] : [],
    advanced: { disableOriginCheck: false, disableCSRFCheck: false, ipAddress: { ipAddressHeaders: ["x-test-ip"] } }, logger: { disabled: true },
    rateLimit: { enabled: true, storage: "memory", window: 60, max: 1000 },
  });
  const call = (path: string, body?: object, cookie?: string, origin: string | null = baseURL) => auth.handler(new Request(`${baseURL}/api/auth/${path}`, {
    method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", "x-test-ip": ip, ...(cookie ? { Cookie: cookie } : {}), ...(origin ? { Origin: origin } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }));
  const login = async () => {
    const response = await call("sign-up/email", { email: `${crypto.randomUUID()}@example.invalid`, password: "TestOnlyPassword123!", name: "IAP fixture" });
    expect(response.status).toBe(200);
    const cookie = response.headers.getSetCookie().find(v => v.startsWith("better-auth.session_token="))!.split(";", 1)[0]!;
    return { cookie, userId: (await response.json() as { user: { id: string } }).user.id };
  };
  return { auth, call, login, seen, fail: (value: AppStoreError) => { failure = value; }, maintenance: () => maintenance };
}
describe("Better Auth App Store HTTP contract", () => {
  test("sessions supply ownership; caller IDs and unexpected fields are rejected", async () => {
    const f = fixture();
    expect((await f.call("app-store/account-token", {})).status).toBe(401);
    expect((await f.call("app-store/status")).status).toBe(401);
    const { cookie, userId } = await f.login();
    const response = await f.call("app-store/account-token", {}, cookie);
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(f.seen.at(-1)).toEqual({ action: "accountToken", userId });
    expect((await f.call("app-store/sync", { signedTransaction: "verified", userId: "attacker" }, cookie)).status).toBe(400);
    expect((await f.call("app-store/sync", { signedTransaction: "verified" }, cookie)).status).toBe(200);
    expect(f.seen.at(-1)).toEqual({ action: "sync", userId, restore: false });
    expect((await f.call("app-store/restore", { signedTransaction: "verified" }, cookie)).status).toBe(200);
    expect(f.seen.at(-1)).toEqual({ action: "sync", userId, restore: true });
    expect((await f.call("app-store/status", undefined, cookie)).status).toBe(200);
    expect((await f.call("app-store/status?environment=Sandbox", undefined, cookie)).status).toBe(400);
    expect((await f.call("app-store/status?environment=Xcode", undefined, cookie)).status).toBe(400);
  });
  test("CSRF checks remain enabled for account writes; only verified notifications bypass Origin", async () => {
    const f = fixture(); const { cookie } = await f.login();
    for (const origin of [null, "https://attacker.example.invalid"]) {
      expect((await f.call("app-store/account-token", {}, cookie, origin)).status).toBe(403);
      expect((await f.call("app-store/sync", { signedTransaction: "verified" }, cookie, origin)).status).toBe(403);
      expect((await f.call("update-user", { name: "blocked" }, cookie, origin)).status).toBe(403);
      expect((await f.call("app-store/notifications", { signedPayload: "verified" }, cookie, origin)).status).toBe(200);
    }
    expect((await f.call("app-store/notifications", { signedPayload: "verified" }, undefined, null)).status).toBe(200);
    expect((await f.call("app-store/notifications", { signedPayload: "forged" }, undefined, null)).status).toBe(400);
  });
  test("oversized and non-JSON requests fail before the verifier, including streaming bodies", async () => {
    const f = fixture();
    const response = await f.auth.handler(new Request(`${baseURL}/api/auth/app-store/notifications`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(65537)); c.close(); } }),
    }));
    expect(response.status).toBe(413); expect(f.seen).toHaveLength(0);
    const wrongType = await f.auth.handler(new Request(`${baseURL}/api/auth/app-store/notifications`, { method: "POST", body: "signedPayload=verified" }));
    expect(wrongType.status).toBe(415); expect(f.seen).toHaveLength(0);
  });
  test("typed client sends empty account-token as POST and infers status and sync results", async () => {
    const f = fixture(); const { cookie } = await f.login();
    const methods: string[] = [];
    const client = createAuthClient({ baseURL, plugins: [appStoreClient()], fetchOptions: {
      headers: { cookie, origin: baseURL }, customFetchImpl: async (input, init) => {
        const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init); methods.push(request.method); return f.auth.handler(request);
      },
    } });
    const token = await client.appStore.accountToken();
    expect(token.error).toBeNull(); expect(token.data?.appAccountToken).toHaveLength(36); expect(methods).toEqual(["POST"]);
    const result = await client.appStore.sync({ signedTransaction: "verified" });
    expect(result.data?.binding).toBe("bound"); expect(result.data?.status.entitlements).toEqual([]);
    const status = await client.appStore.status({ query: { environment: "Production" } });
    expect(status.data?.environment).toBe("Production");
  });
  test("disabled plugin has no routes and maintenance is never an HTTP endpoint", async () => {
    const disabled = fixture(false);
    expect((await disabled.call("app-store/status")).status).toBe(404);
    expect((await disabled.call("app-store/notifications", { signedPayload: "verified" })).status).toBe(404);
    const f = fixture();
    expect((await f.call("run-app-store-maintenance", {})).status).toBe(404);
    expect((await f.call("app-store/maintenance", {})).status).toBe(404);
    await f.auth.api.runAppStoreMaintenance(); expect(f.maintenance()).toBe(1);
  });
  test("domain errors remain actionable without revealing signed data", async () => {
    const f = fixture(); const { cookie } = await f.login();
    for (const [code, status] of [["SUBSCRIPTION_OWNERSHIP_CONFLICT", 409], ["VERIFICATION_UNAVAILABLE", 503]] as const) {
      f.fail(new AppStoreError(code));
      const response = await f.call("app-store/sync", { signedTransaction: "sensitive-payload" }, cookie);
      expect(response.status).toBe(status);
      const body = await response.text(); expect(body).toContain(code); expect(body).not.toContain("sensitive-payload");
    }
  });
  test("sync has a real request quota while notification exemption is explicit", async () => {
    const f = fixture(); const { cookie } = await f.login();
    const context = await f.auth.$context;
    expect(context.skipOriginCheck).toContain("/app-store/notifications");
    expect((context.options as BetterAuthOptions).rateLimit?.customRules?.["/app-store/notifications"]).toBe(false);
    for (let i = 0; i < 10; i++) expect((await f.call("app-store/sync", { signedTransaction: "verified" }, cookie)).status).toBe(200);
    expect((await f.call("app-store/sync", { signedTransaction: "verified" }, cookie)).status).toBe(429);
    expect((await f.call("app-store/notifications", { signedPayload: "verified" }, cookie, null)).status).toBe(200);
  });
});
test("browser client entry bundles without Apple SDK, database or Node runtime code", async () => {
  const build = await Bun.build({ entrypoints: [new URL("./client.ts", import.meta.url).pathname], target: "browser" });
  expect(build.success).toBe(true);
  const source = await build.outputs[0]!.text();
  for (const forbidden of ["node:crypto", "node-fetch", "SignedDataVerifier", "AppStoreServerAPIClient", "drizzle", "pg-pool"]) expect(source).not.toContain(forbidden);
});
test("maintenance starts explicitly, prevents overlap and drains the active work", async () => {
  let runs = 0, finish!: () => void, stopping!: () => boolean;
  const scheduler = startAppStoreMaintenance({ event() {}, async maintain(shouldStop) { runs++; stopping = shouldStop!; await new Promise<void>(resolve => { finish = resolve; }); } }, 5);
  await new Promise(resolve => setTimeout(resolve, 20)); expect(runs).toBe(1);
  let drained = false; const drain = scheduler.stopAndDrain().then(() => { drained = true; });
  expect(stopping()).toBe(true); expect(drained).toBe(false);
  finish(); await drain; expect(drained).toBe(true);
});
