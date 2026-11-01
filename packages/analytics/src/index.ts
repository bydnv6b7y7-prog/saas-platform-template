export type AuthMethod = "email" | "google" | "github" | "apple";

export type AssistantOpenSource = "floating_orb" | "page_cta";
export type BillingInterval = "month" | "year";

type BillingEventProperties = {
  billing_interval: BillingInterval;
  plan: string;
};

type SubscriptionEventProperties = {
  billing_interval: string | null;
  event_source: "stripe_webhook";
  plan: string;
  status: string;
};

/**
 * Events a product adds, by declaration merging from its own code (docs/analytics.md):
 *
 *   declare module "@northwind/analytics" {
 *     interface ProductAnalyticsEvents { note_created: { has_attachment: boolean } }
 *   }
 */
export interface ProductAnalyticsEvents {}

/**
 * Shared, low-cardinality product analytics contract.
 *
 * Never add credentials, form values, query text, AI messages, Stripe object
 * identifiers, internal billing-row IDs, or unbounded error strings to these
 * properties.
 */
export type AnalyticsEventMap = ProductAnalyticsEvents & {
  user_signed_up: {
    auth_method: AuthMethod;
    event_source: "auth_database_hook";
  };
  assistant_opened: {
    path: string;
    source: AssistantOpenSource;
  };
  billing_interval_selected: {
    billing_interval: BillingInterval;
  };
  billing_checkout_started: BillingEventProperties & {
    currency: "USD";
    list_price_minor: number;
  };
  billing_checkout_failed: BillingEventProperties & {
    failure_kind: "request_error" | "unknown";
  };
  subscription_started: SubscriptionEventProperties & {
    currency?: string;
    list_price_minor?: number;
    product: `${string}_pro`;
  };
  subscription_cancel_scheduled: SubscriptionEventProperties;
  subscription_ended: SubscriptionEventProperties;
};

export type AnalyticsEventName = keyof AnalyticsEventMap;
