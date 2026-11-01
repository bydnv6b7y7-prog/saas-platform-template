import { describe, expect, test } from "bun:test";

import {
  createPostHogPersonDeleter,
  usageSubjectHash,
  verificationIdentifiersForEmail,
} from "./account-deletion";

describe("usageSubjectHash", () => {
  test("pins the packages/api privacyHash formula with fixed vectors", () => {
    // sha256(`${secret}:${value}`) hex, identical to packages/api/src/usage.ts.
    expect(usageSubjectHash("value", "secret")).toBe(
      "37d970b2467eb9ed4713479022259f835ac9ccc8aafc4cebe0ee382250f97044",
    );
    expect(usageSubjectHash("user_123", "test-secret")).toBe(
      "6676ba50dad84d7fa06a524bf6f93044bf0a75630f358a6ab6022e242aaa3d14",
    );
  });
});

describe("verificationIdentifiersForEmail", () => {
  test("covers the OTP identifier plus both policy lease identifiers", () => {
    const identifiers = verificationIdentifiersForEmail("User@Example.com");
    const identity = Bun.SHA256.hash("User@Example.com", "hex");
    expect(identifiers).toEqual([
      "email-verification-otp-User@Example.com",
      `northwind:email-otp:operation:${identity}`,
      `northwind:email-otp:cooldown:${identity}`,
    ]);
  });
});

describe("createPostHogPersonDeleter", () => {
  test("posts a bulk person deletion with the personal API key", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const deleter = createPostHogPersonDeleter(
      {
        configured: true,
        host: "https://us.posthog.com",
        projectId: "123456",
        personalApiKey: "phx_test_key",
      },
      async (url, init) => {
        calls.push({ url, init });
        return new Response("{}");
      },
    );
    await deleter("user_123");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "https://us.posthog.com/api/environments/123456/persons/bulk/delete/",
    );
    expect(calls[0]!.init.method).toBe("POST");
    expect(new Headers(calls[0]!.init.headers).get("Authorization")).toBe(
      "Bearer phx_test_key",
    );
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      distinct_ids: ["user_123"],
      delete_events: true,
      delete_recordings: false,
    });
  });

  test("surfaces non-2xx responses as errors", async () => {
    const deleter = createPostHogPersonDeleter(
      {
        configured: true,
        host: "https://us.posthog.com",
        projectId: "1",
        personalApiKey: "phx_test_key",
      },
      async () => new Response("nope", { status: 403 }),
    );
    await expect(deleter("user_123")).rejects.toThrow(/failed with 403/);
  });
});
