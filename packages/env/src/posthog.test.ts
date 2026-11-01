import { describe, expect, test } from "bun:test";

import { platformServerSchema } from "./platform-server-schema";
import { platformWebSchema } from "./platform-web-schema";
import {
  isPostHogProjectToken,
  POSTHOG_BROWSER_PROXY_HOST,
  POSTHOG_INGESTION_HOST,
  POSTHOG_UI_HOST,
  posthogPersonalApiKeySchema,
  posthogProjectIdSchema,
  posthogProjectTokenSchema,
  resolvePostHogDeletionConfig,
} from "./posthog";

describe("PostHog configuration", () => {
  test("accepts project tokens and trims environment input", () => {
    const token = `phc_${"a".repeat(20)}`;
    expect(isPostHogProjectToken(token)).toBe(true);
    expect(posthogProjectTokenSchema.parse(` ${token} `)).toBe(token);
  });

  test("rejects placeholders, personal keys, and malformed values", () => {
    for (const value of ["phc_replace-me", "phx_abcdefghijklmnopqrstuvwxyz", "", undefined]) {
      expect(isPostHogProjectToken(value)).toBe(false);
      expect(posthogProjectTokenSchema.safeParse(value).success).toBe(false);
    }
  });

  test("keeps browser proxy, server ingestion, and project UI endpoints separate", () => {
    expect(POSTHOG_BROWSER_PROXY_HOST).toBe("https://ingest.northwind.dev");
    expect(POSTHOG_INGESTION_HOST).toBe("https://us.i.posthog.com");
    expect(POSTHOG_UI_HOST).toBe("https://us.posthog.com");
    expect(platformWebSchema.VITE_POSTHOG_HOST.parse(undefined)).toBe(
      POSTHOG_BROWSER_PROXY_HOST,
    );
    expect(platformServerSchema.POSTHOG_HOST.parse(undefined)).toBe(
      POSTHOG_INGESTION_HOST,
    );
  });

  test("deletion config requires both personal key and project ID", () => {
    const personalApiKey = `phx_${"a".repeat(12)}`;
    expect(resolvePostHogDeletionConfig({})).toEqual({ configured: false });
    expect(() =>
      resolvePostHogDeletionConfig({ POSTHOG_PERSONAL_API_KEY: personalApiKey }),
    ).toThrow(/must be set together/);
    expect(() =>
      resolvePostHogDeletionConfig({ POSTHOG_PROJECT_ID: "123456" }),
    ).toThrow(/must be set together/);
    expect(
      resolvePostHogDeletionConfig({
        POSTHOG_PERSONAL_API_KEY: ` ${personalApiKey} `,
        POSTHOG_PROJECT_ID: " 123456 ",
      }),
    ).toEqual({
      configured: true,
      host: POSTHOG_UI_HOST,
      projectId: "123456",
      personalApiKey,
    });
  });

  test("deletion schemas reject project tokens as personal keys and non-numeric project IDs", () => {
    expect(
      posthogPersonalApiKeySchema.safeParse(`phc_${"a".repeat(20)}`).success,
    ).toBe(false);
    expect(posthogPersonalApiKeySchema.safeParse(`phx_${"a".repeat(12)}`).success).toBe(
      true,
    );
    expect(posthogProjectIdSchema.safeParse("123456").success).toBe(true);
    for (const value of ["abc", "12 34", "-1", "", undefined]) {
      expect(posthogProjectIdSchema.safeParse(value).success).toBe(false);
    }
  });
});
