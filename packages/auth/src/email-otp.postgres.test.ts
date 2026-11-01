import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/bun-sql";
import * as schema from "@northwind/db/schema/auth";

import { createEmailVerificationOptions } from "./email-verification";
import type { EmailMessage } from "./email";

const url = process.env.EMAIL_OTP_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite("email OTP / PostgreSQL concurrency", () => {
  if (url && (!['127.0.0.1', 'localhost', 'postgres'].includes(new URL(url).hostname)
    || new URL(url).pathname !== '/email_otp_test')) throw new Error("Use only the dedicated local email_otp_test database");
  const sql = new SQL(url!);
  const messages: EmailMessage[] = [];
  const email = "parallel@example.invalid";
  const secret = "isolated-postgres-email-otp-test-secret-32-characters";
  const makeAuth = () => {
    const options = createEmailVerificationOptions(async message => { messages.push(message); });
    return betterAuth({ ...options, secret, baseURL: "http://localhost:4199", logger: { disabled: true },
      database: drizzleAdapter(drizzle(sql), { provider: "pg", schema }),
      rateLimit: { ...options.rateLimit, enabled: false },
    });
  };
  const a = makeAuth(), b = makeAuth();
  const call = (auth: typeof a, path: string, body: object) => auth.handler(new Request(`http://localhost:4199/api/auth/${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost:4199" }, body: JSON.stringify(body),
  }));
  const send = (auth = a) => call(auth, "email-otp/send-verification-otp", { email, type: "email-verification" });
  const code = () => messages.at(-1)!.text.split("\n\n")[1]!;
  const verify = (auth = a, otp = code()) => call(auth, "email-otp/verify-email", { email, otp });
  beforeAll(async () => {
    await sql.unsafe(`CREATE TABLE IF NOT EXISTS "user" (
      id text PRIMARY KEY, name text NOT NULL, email text NOT NULL UNIQUE, email_verified boolean NOT NULL DEFAULT false,
      image text, created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now(),
      stripe_customer_id text, role text, banned boolean DEFAULT false, ban_reason text, ban_expires timestamp);
      CREATE TABLE IF NOT EXISTS "account" (
      id text PRIMARY KEY, issuer text, account_id text NOT NULL, provider_id text NOT NULL, user_id text NOT NULL REFERENCES "user"(id),
      access_token text, refresh_token text, id_token text, access_token_expires_at timestamp, refresh_token_expires_at timestamp,
      scope text, password text, created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS "session" (
      id text PRIMARY KEY, token text NOT NULL UNIQUE, user_id text NOT NULL REFERENCES "user"(id), expires_at timestamp NOT NULL,
      created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now(), ip_address text, user_agent text, impersonated_by text);
      CREATE TABLE IF NOT EXISTS verification (
      id text PRIMARY KEY, identifier text NOT NULL, value text NOT NULL, expires_at timestamp NOT NULL,
      created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now());`);
  });
  beforeEach(async () => {
    await sql.unsafe('TRUNCATE "session", "account", "user", verification CASCADE');
    messages.length = 0;
    expect((await call(a, "sign-up/email", { email, password: "OnlyForFixture123!", name: "Fixture" })).status).toBe(200);
  });
  afterAll(async () => { await sql.close(); });

  test("two auth instances admit one simultaneous send and preserve cooldown across recreation", async () => {
    const results = await Promise.all([send(a), send(b)]);
    expect(results.map(response => response.status).sort()).toEqual([200, 429]);
    expect(messages).toHaveLength(1);
    expect((await send(makeAuth())).status).toBe(429);
    expect((await verify(b)).status).toBe(200);
  });

  test("concurrent verifications create exactly one session and no replay", async () => {
    await send();
    const responses = await Promise.all([verify(a), verify(b)]);
    expect(responses.filter(response => response.status === 200)).toHaveLength(1);
    expect((await sql.unsafe('SELECT count(*)::int AS count FROM "session"'))[0].count).toBe(1);
    expect((await verify(b)).status).toBe(400);
  });

  test("parallel guesses cannot bypass the three-attempt budget", async () => {
    await send();
    const wrong = code() === "000000" ? "111111" : "000000";
    for (let i = 0; i < 3; i++) {
      const responses = await Promise.all([verify(a, wrong), verify(b, wrong)]);
      expect(responses.every(response => response.status !== 200)).toBe(true);
    }
    expect((await verify()).status).not.toBe(200);
    expect((await sql.unsafe('SELECT count(*)::int AS count FROM "session"'))[0].count).toBe(0);
  });
});
