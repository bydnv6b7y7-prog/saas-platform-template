import { describe, expect, test } from "bun:test";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";

import { createEmailVerificationOptions } from "./email-verification";
import type { EmailMessage } from "./email";

const baseURL = "http://localhost:3999";
const webOrigin = "http://localhost:3998";
const credentials = { email: "reader@example.invalid", password: "FixtureOnlyPass123!" };
let fixtureId = 0;

function fixture(rateLimit = false) {
  const database: Record<string, any[]> = { user: [], session: [], account: [], verification: [] };
  const messages: EmailMessage[] = [];
  let failDelivery = false;
  const options = createEmailVerificationOptions(async (message) => {
    if (failDelivery) throw new Error("sensitive upstream detail");
    messages.push(message);
  });
  const auth = betterAuth({
    ...options, database: memoryAdapter(database), baseURL,
    secret: "isolated-email-test-secret-with-more-than-32-characters",
    trustedOrigins: [webOrigin],
    advanced: { disableOriginCheck: false, disableCSRFCheck: false },
    rateLimit: { ...options.rateLimit, enabled: rateLimit },
    logger: { disabled: true },
  });
  const ip = `192.0.2.${++fixtureId}`;
  const call = (path: string, body?: object, cookie?: string, origin = webOrigin, address = ip) => auth.handler(new Request(
    `${baseURL}/api/auth/${path}`, { method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json", Origin: origin, "x-forwarded-for": address, ...(cookie ? { Cookie: cookie } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  ));
  const signUp = () => call("sign-up/email", { ...credentials, name: "Email fixture" });
  const send = (email = credentials.email, address = ip) => call("email-otp/send-verification-otp", { email, type: "email-verification" }, undefined, webOrigin, address);
  const code = () => messages.at(-1)!.text.split("\n\n")[1]!;
  const verify = (otp = code(), origin = webOrigin) => call("email-otp/verify-email", { email: credentials.email, otp }, undefined, origin);
  const expireCooldown = () => database.verification!.filter(row => row.identifier.startsWith("northwind:email-otp:cooldown:")).forEach(row => { row.expiresAt = new Date(0); });
  return { call, signUp, send, code, verify, messages, database, expireCooldown, setFailDelivery: (value: boolean) => { failDelivery = value; } };
}

function sessionCookie(response: Response) {
  return response.headers.getSetCookie().find(cookie => cookie.startsWith("better-auth.session_token="))?.split(";")[0];
}

describe("email OTP through the real Better Auth handler", () => {
  test("signup/login stay unauthenticated until verification returns a usable cookie to the submitting client", async () => {
    const f = fixture();
    const signup = await f.signUp();
    expect(await signup.json()).toMatchObject({ token: null, user: { emailVerified: false } });
    expect(sessionCookie(signup)).toBeUndefined();
    const login = await f.call("sign-in/email", credentials);
    expect(login.status).toBe(403);
    expect(await login.json()).toMatchObject({ code: "EMAIL_NOT_VERIFIED" });
    expect(f.messages).toHaveLength(0);
    expect((await f.send()).status).toBe(200);
    expect(f.code()).toMatch(/^[0-9]{6}$/);
    expect(f.messages[0]!.text).toContain("5 minutes");
    expect(f.messages[0]!.html).not.toContain("href=");
    const stored = f.database.verification!.find(row => row.identifier.startsWith("email-verification-otp-"));
    expect(stored.value).not.toContain(f.code());
    expect(stored.expiresAt.getTime() - Date.now()).toBeGreaterThan(290_000);
    const verified = await f.verify(undefined, baseURL); // Native Origin + native cookie jar.
    expect(verified.status).toBe(200);
    expect(await verified.json()).toMatchObject({ status: true, user: { emailVerified: true } });
    expect(sessionCookie(verified)).toBeTruthy();
    expect(await (await f.call("get-session", undefined, sessionCookie(verified))).json()).toMatchObject({ user: { emailVerified: true } });
    expect(f.database.session).toHaveLength(1);
    expect((await f.verify()).status).toBe(400);
    expect(f.database.session).toHaveLength(1);
    expect((await f.call("sign-in/email", credentials)).status).toBe(200);
  });

  test("three incorrect guesses exhaust a code, and expired/malformed codes cannot create sessions", async () => {
    const f = fixture(); await f.signUp(); await f.send();
    const wrong = f.code() === "000000" ? "111111" : "000000";
    for (let i = 0; i < 3; i++) expect((await f.verify(wrong)).status).toBe(400);
    const exhausted = await f.verify();
    expect(exhausted.status).toBe(403);
    expect(await exhausted.json()).toMatchObject({ code: "TOO_MANY_ATTEMPTS" });
    f.expireCooldown(); await f.send();
    f.database.verification!.filter(row => row.identifier.startsWith("email-verification-otp-")).forEach(row => { row.expiresAt = new Date(0); });
    expect((await f.verify()).status).toBe(400);
    for (const code of ["1", "12345a", "1234567"]) expect((await f.verify(code)).status).toBe(400);
    expect(f.database.user).toMatchObject([{ emailVerified: false }]);
    expect(f.database.session).toHaveLength(0);
  });

  test("resending removes every older code", async () => {
    const f = fixture(); await f.signUp(); await f.send();
    const previous = f.code(); f.expireCooldown(); await f.send();
    expect(f.database.verification!.filter(row => row.identifier.startsWith("email-verification-otp-"))).toHaveLength(1);
    if (previous !== f.code()) expect((await f.verify(previous)).status).toBe(400);
    expect((await f.verify()).status).toBe(200);
  });

  test("mailbox cooldown survives a different IP and IP limits cover different mailboxes", async () => {
    const f = fixture(true); await f.signUp(); await f.send();
    const sameMailbox = await f.send(credentials.email.toUpperCase(), "198.51.100.201");
    expect(sameMailbox.status).toBe(429);
    expect(Number(sameMailbox.headers.get("x-retry-after"))).toBeGreaterThan(0);
    const sameIP = await f.send("different@example.invalid");
    expect(sameIP.status).toBe(429);
    expect(f.messages).toHaveLength(1);
  });

  test("unknown and already-verified accounts receive generic responses without mail or new login", async () => {
    const f = fixture(); await f.signUp();
    expect(await (await f.send("unknown@example.invalid")).json()).toEqual({ success: true });
    expect(f.messages).toHaveLength(0);
    await f.send(); await f.verify(); f.expireCooldown();
    expect(await (await f.send()).json()).toEqual({ success: true });
    expect(f.messages).toHaveLength(1);
    expect((await f.verify()).status).toBe(400);
    expect(f.database.session).toHaveLength(1);
  });

  test("reports delivery failure, releases operation lease, and allows retry after cooldown", async () => {
    const f = fixture(); await f.signUp(); f.setFailDelivery(true);
    const failure = await f.send();
    expect(failure.status).toBe(503);
    expect(await failure.json()).toEqual({ code: "EMAIL_DELIVERY_FAILED", message: "The verification email could not be sent. Please try again shortly." });
    expect(f.database.verification!.some(row => row.identifier.startsWith("northwind:email-otp:operation:"))).toBe(false);
    f.expireCooldown(); f.setFailDelivery(false);
    expect((await f.send()).status).toBe(200);
    expect((await f.verify()).status).toBe(200);
  });

  test("rejects foreign origins, non-verification purposes, and all alternative OTP/link endpoints", async () => {
    const f = fixture(); await f.signUp();
    expect((await f.call("email-otp/send-verification-otp", { email: credentials.email, type: "email-verification" }, undefined, "https://attacker.invalid")).status).toBe(403);
    for (const type of ["sign-in", "forget-password", "change-email"]) expect((await f.call("email-otp/send-verification-otp", { email: credentials.email, type })).status).toBe(400);
    for (const path of ["send-verification-email", "verify-email", "sign-in/email-otp", "email-otp/check-verification-otp", "email-otp/get-verification-otp", "email-otp/request-password-reset", "email-otp/reset-password"]) {
      expect((await f.call(path, { email: credentials.email, otp: "123456", type: "email-verification" })).status).toBe(404);
    }
    expect(f.messages).toHaveLength(0);
    expect(f.database.session).toHaveLength(0);
  });
});
