import type { SocialProviderId } from "./auth-client";

export const socialProviderLabels: Record<SocialProviderId, string> = {
  google: "Google",
  github: "GitHub",
  apple: "Apple",
};

export function getOAuthErrorMessage(
  errorCode: string | undefined,
  provider: SocialProviderId | undefined,
): string | null {
  if (!errorCode) return null;
  const providerLabel = provider ? socialProviderLabels[provider] : "The provider";

  switch (errorCode.toLowerCase()) {
    case "access_denied":
      return `${providerLabel} sign-in was cancelled.`;
    case "account_not_linked":
      return `This email already has an account. Confirm your email and password once to securely connect ${providerLabel}.`;
    case "signup_disabled":
      return "Account creation is currently unavailable.";
    case "email_not_found":
      return `${providerLabel} did not provide a usable email address. Check the provider's email permissions and try again.`;
    case "email_does_not_match":
    case "email_doesn't_match": // Accept callbacks started before the Better Auth 1.7 deploy.
      return `${providerLabel} uses a different email address and cannot be connected to this account.`;
    case "state_mismatch":
    case "state_not_found":
      return "The sign-in request expired or its security check failed. Please try again.";
    default:
      return "Social sign-in could not be completed. Please try again.";
  }
}

export function getOAuthErrorURL({
  provider,
  redirectTo,
  intent,
  linking = false,
}: {
  provider: SocialProviderId;
  redirectTo?: string;
  intent?: "sign-in" | "sign-up";
  linking?: boolean;
}): string {
  const url = new URL("/login", window.location.origin);
  url.searchParams.set("provider", provider);
  if (redirectTo) url.searchParams.set("redirect", redirectTo);
  if (intent === "sign-up") url.searchParams.set("signup", "1");
  if (linking) url.searchParams.set("link", "1");
  return url.toString();
}
