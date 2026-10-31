import { describe, expect, test } from "bun:test";
import { decodeJwt, decodeProtectedHeader, exportPKCS8, generateKeyPair } from "jose";

import { createSocialProviderConfiguration } from "./social-providers";

describe("social provider configuration", () => {
  test("leaves unconfigured providers disabled", () => {
    const result = createSocialProviderConfiguration({});

    expect(result.enabledProviderIds).toEqual([]);
    expect(result.providers).toEqual({});
  });

  test("rejects partial credential groups", () => {
    expect(() =>
      createSocialProviderConfiguration({
        googleClientId: "google-client-id",
      }),
    ).toThrow("Incomplete google OAuth configuration; missing GOOGLE_CLIENT_SECRET");
  });

  test("allows provider-created accounts and always requests account selection", () => {
    const result = createSocialProviderConfiguration({
      googleClientId: "google-client-id",
      googleClientSecret: "google-client-secret",
      githubClientId: "github-client-id",
      githubClientSecret: "github-client-secret",
    });

    expect(result.enabledProviderIds).toEqual(["google", "github"]);
    expect(result.providers.google).toMatchObject({ prompt: "select_account" });
    expect(result.providers.google).not.toHaveProperty("disableImplicitSignUp");
    expect(result.providers.google).not.toHaveProperty("disableSignUp");
    expect(result.providers.github).toMatchObject({ prompt: "select_account" });
    expect(result.providers.github).not.toHaveProperty("disableImplicitSignUp");
    expect(result.providers.github).not.toHaveProperty("disableSignUp");
  });

  test("generates a signed 180-day Apple client secret", async () => {
    const { privateKey } = await generateKeyPair("ES256", { extractable: true });
    const privateKeyPem = await exportPKCS8(privateKey);
    const result = createSocialProviderConfiguration({
      appleClientId: "com.example.web",
      appleTeamId: "TEAM123456",
      appleKeyId: "KEY1234567",
      applePrivateKeyBase64: Buffer.from(privateKeyPem).toString("base64"),
    });
    const apple = result.providers.apple;

    expect(result.enabledProviderIds).toEqual(["apple"]);
    expect(typeof apple).toBe("function");
    if (typeof apple !== "function") throw new Error("Expected async Apple provider config");

    const options = await apple();
    const payload = decodeJwt(options.clientSecret!);
    const header = decodeProtectedHeader(options.clientSecret!);

    expect(options.clientId).toBe("com.example.web");
    expect(options).not.toHaveProperty("prompt");
    expect(options).not.toHaveProperty("disableImplicitSignUp");
    expect(options).not.toHaveProperty("disableSignUp");
    expect(header).toMatchObject({ alg: "ES256", kid: "KEY1234567" });
    expect(payload).toMatchObject({
      iss: "TEAM123456",
      sub: "com.example.web",
      aud: "https://appleid.apple.com",
    });
    expect(payload.exp! - payload.iat!).toBe(180 * 24 * 60 * 60);
  });

  test("rejects an invalid Apple private key before startup", () => {
    const invalidPem = [
      "-----BEGIN PRIVATE KEY-----",
      "AAAA",
      "-----END PRIVATE KEY-----",
    ].join("\n");
    expect(() =>
      createSocialProviderConfiguration({
        appleClientId: "com.example.web",
        appleTeamId: "TEAM123456",
        appleKeyId: "KEY1234567",
        applePrivateKeyBase64: Buffer.from(invalidPem).toString("base64"),
      }),
    ).toThrow("APPLE_PRIVATE_KEY_BASE64");
  });
});
