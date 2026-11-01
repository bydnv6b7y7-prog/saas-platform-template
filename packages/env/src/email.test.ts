import { describe, expect, test } from "bun:test";
import { readCloudflareEmailConfiguration } from "./email";

const environment = {
  CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
  CLOUDFLARE_EMAIL_API_TOKEN: "fixture-token",
  EMAIL_FROM: "accounts@example.invalid",
};

describe("Cloudflare email configuration", () => {
  test("allows an absent configuration and validates a complete group", () => {
    expect(readCloudflareEmailConfiguration({})).toBeNull();
    expect(readCloudflareEmailConfiguration({ EMAIL_FROM: "" })).toBeNull();
    expect(readCloudflareEmailConfiguration(environment)).toEqual({
      accountId: environment.CLOUDFLARE_ACCOUNT_ID,
      apiToken: environment.CLOUDFLARE_EMAIL_API_TOKEN,
      from: environment.EMAIL_FROM,
    });
  });

  test("accepts a display name and returns the Cloudflare REST address object", () => {
    expect(readCloudflareEmailConfiguration({
      ...environment,
      EMAIL_FROM: "Northwind <noreply@northwind.dev>",
    })?.from).toEqual({ address: "noreply@northwind.dev", name: "Northwind" });
  });

  test("rejects partial credentials, path injection and invalid sender addresses", () => {
    expect(() => readCloudflareEmailConfiguration({ EMAIL_FROM: environment.EMAIL_FROM })).toThrow("missing CLOUDFLARE_ACCOUNT_ID");
    for (const [key, value] of [
      ["CLOUDFLARE_ACCOUNT_ID", "../other-account"],
      ["EMAIL_FROM", "Name <not-an-email>"],
      ["EMAIL_FROM", "<accounts@example.invalid>"],
      ["EMAIL_FROM", "First <first@example.invalid>, Second <second@example.invalid>"],
      ["EMAIL_FROM", "Name\r\n <accounts@example.invalid>"],
      ["EMAIL_FROM", "accounts@example.invalid\nBcc: other@example.invalid"],
      ["CLOUDFLARE_EMAIL_API_TOKEN", "token\nmalicious"],
    ]) {
      expect(() => readCloudflareEmailConfiguration({ ...environment, [key!]: value })).toThrow();
    }
  });
});
