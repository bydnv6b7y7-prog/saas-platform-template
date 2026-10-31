import { stripeClient } from "@better-auth/stripe/client";
import { adminClient, emailOTPClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

import { getApiBaseURL } from "./api-url";

export const socialProviderIds = ["google", "github", "apple"] as const;
export type SocialProviderId = (typeof socialProviderIds)[number];

const apiBaseURL = getApiBaseURL();
export const authBaseURL = new URL("/api/auth", `${apiBaseURL}/`).toString();

export const authClient = createAuthClient({
  // better-auth derives its route-matching base from this URL's path, so the
  // public auth path must equal the server-side mount (/api/auth everywhere)
  baseURL: authBaseURL,
  plugins: [adminClient(), stripeClient({ subscription: true }), emailOTPClient()],
});

export async function getEnabledSocialProviders(): Promise<SocialProviderId[]> {
  try {
    const response = await fetch(new URL("providers", `${authBaseURL}/`), {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return [];

    const body = (await response.json()) as { providers?: unknown };
    const providers = body.providers;
    if (!Array.isArray(providers)) return [];

    return socialProviderIds.filter((provider) => providers.includes(provider));
  } catch {
    // Email/password remains usable if provider discovery is temporarily unavailable.
    return [];
  }
}
