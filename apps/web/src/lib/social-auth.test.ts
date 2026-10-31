import { describe, expect, test } from "bun:test";

import { getOAuthErrorMessage } from "./social-auth";

describe("OAuth error messages", () => {
  test("guides an existing account through secure linking", () => {
    expect(getOAuthErrorMessage("account_not_linked", "github")).toBe(
      "This email already has an account. Confirm your email and password once to securely connect GitHub.",
    );
  });

  test("does not expose unknown provider error details", () => {
    expect(getOAuthErrorMessage("provider_internal_detail", "google")).toBe(
      "Social sign-in could not be completed. Please try again.",
    );
  });

  test("uses a generic message when provider sign-up is unavailable", () => {
    expect(getOAuthErrorMessage("signup_disabled", "apple")).toBe(
      "Account creation is currently unavailable.",
    );
  });
});
