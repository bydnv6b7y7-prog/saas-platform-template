export type StripeSecretMode = "test" | "live";

/** Classifies server-side Stripe keys without exposing or contacting Stripe. */
export function stripeSecretMode(secretKey: string): StripeSecretMode | null {
  const value = secretKey.trim();
  if (/^(?:sk|rk)_live_/.test(value)) return "live";
  if (/^(?:(?:sk|rk)_test_|rkcs_test_)/.test(value)) return "test";
  return null;
}
