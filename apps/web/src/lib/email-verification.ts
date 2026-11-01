import { getAbsoluteAppURL } from "./app-url";
import type { SocialProviderId } from "./auth-client";

export function safeRedirectTarget(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const target = value.trim();
  if (
    target.length > 300 ||
    !target.startsWith("/") ||
    target.startsWith("//") ||
    target.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(target)
  ) return undefined;
  return target;
}

export function getEmailVerificationCallbackURL(
  redirectTo?: string,
  linkingProvider?: SocialProviderId,
) {
  // This URL is used only for navigation in the current Web client after its
  // verified session is confirmed; it is never sent in a verification email.
  const callback = new URL(getAbsoluteAppURL("/login"));
  callback.searchParams.set("verification", "1");
  const target = safeRedirectTarget(redirectTo);
  if (target) callback.searchParams.set("redirect", target);
  if (linkingProvider) {
    callback.searchParams.set("provider", linkingProvider);
    callback.searchParams.set("link", "1");
  }
  return callback.toString();
}

export function getEmailOTPErrorMessage(code?: string, status?: number): string {
  if (status === 429) return "Please wait before trying again.";
  if (code === "OTP_EXPIRED") return "This code has expired. Request a new code.";
  if (code === "TOO_MANY_ATTEMPTS") return "Too many incorrect attempts. Request a new code.";
  return "This code is incorrect or can no longer be used. Check the latest email or request a new code.";
}

export function getEmailVerificationErrorMessage(errorCode?: string): string | null {
  if (!errorCode) return null;
  if (errorCode.toUpperCase() === "TOKEN_EXPIRED") {
    return "Your verification link has expired. Sign in below to request a new email.";
  }
  return "This verification link is invalid or could not be used. Sign in below to request a new email.";
}
