import { describe, expect, test } from "bun:test";
import { getEmailVerificationCallbackURL, getEmailVerificationErrorMessage, getEmailOTPErrorMessage, safeRedirectTarget } from "./email-verification";

describe("verification return scope", () => {
  test("OTP failures describe expiry, attempts, and throttling without exposing server details", () => {
    expect(getEmailOTPErrorMessage("OTP_EXPIRED")).toContain("expired");
    expect(getEmailOTPErrorMessage("TOO_MANY_ATTEMPTS")).toContain("incorrect attempts");
    expect(getEmailOTPErrorMessage(undefined, 429)).toContain("wait");
    expect(getEmailOTPErrorMessage("sensitive provider detail")).not.toContain("sensitive");
  });
  test("preserves a valid destination including filters through the callback", () => {
    const target = "/rankings?genre=6000&chart=topfreeapplications";
    const url = new URL(getEmailVerificationCallbackURL(target));
    expect(url.pathname).toBe("/login");
    expect(url.searchParams.get("verification")).toBe("1");
    expect(url.searchParams.get("redirect")).toBe(target);
    expect(url.searchParams.has("email")).toBe(false);
  });
  test("rejects external, malformed and truncated destinations", () => {
    for (const target of ["https://attacker.example", "//attacker.example", "/\\attacker.example", "/path\nnext", "/" + "x".repeat(301), 123]) {
      expect(safeRedirectTarget(target)).toBeUndefined();
      if (typeof target === "string") expect(new URL(getEmailVerificationCallbackURL(target)).searchParams.has("redirect")).toBe(false);
    }
  });
  test("keeps a social linking continuation separate from verification errors", () => {
    const url = new URL(getEmailVerificationCallbackURL("/settings", "github"));
    expect(url.searchParams.get("provider")).toBe("github");
    expect(url.searchParams.get("link")).toBe("1");
    expect(url.searchParams.has("error")).toBe(false);
  });
  test("explains token expiry without claiming verification or exposing backend errors", () => {
    expect(getEmailVerificationErrorMessage("TOKEN_EXPIRED")).toContain("expired");
    expect(getEmailVerificationErrorMessage("invalid_token")).toContain("invalid");
    expect(getEmailVerificationErrorMessage("sensitive-details")).not.toContain("sensitive-details");
    expect(getEmailVerificationErrorMessage()).toBeNull();
  });
});
