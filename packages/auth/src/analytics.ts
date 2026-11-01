import type {
  AnalyticsEventMap,
  AuthMethod,
} from "@northwind/analytics";
import { env } from "@northwind/env/server";
import type {
  Subscription,
  SubscriptionOptions,
} from "@better-auth/stripe";
import { createHash } from "node:crypto";
import { PostHog } from "posthog-node";
import type { EventMessage } from "posthog-node";
import type Stripe from "stripe";
import { IDENTIFIER_PREFIX } from "@northwind/env/brand";

type SubscriptionAnalyticsCallbacks = Pick<
  SubscriptionOptions,
  "onSubscriptionCancel" | "onSubscriptionComplete" | "onSubscriptionDeleted"
>;

export type AnalyticsTransport = {
  capture: (message: EventMessage) => void;
  shutdown: (shutdownTimeoutMs?: number) => Promise<void>;
};

type AnalyticsErrorHandler = (event: string, error: unknown) => void;
const ANALYTICS_SHUTDOWN_TIMEOUT_MS = 5_000;

function defaultErrorHandler(event: string, error: unknown): void {
  const candidate = error instanceof Error ? error.name : "UnknownError";
  const errorName = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(candidate)
    ? candidate
    : "Error";
  console.error(JSON.stringify({
    level: "error",
    event: "analytics.capture_failed",
    analyticsEvent: event,
    error: { errorName },
  }));
}

export function analyticsEventUuid(sourceId: string, event: string): string {
  const bytes = createHash("sha256").update(`${event}:${sourceId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

type AuthHookContext = {
  params?: { id?: unknown };
  path?: string;
};
const socialAuthMethods: readonly string[] = ["google", "github", "apple"];

export function signupAuthMethodFromContext(
  context: AuthHookContext | null | undefined,
): AuthMethod | null {
  const normalized = context?.path?.toLowerCase().replace(/\/+$/, "");
  if (normalized === "/sign-up/email") return "email";
  if (normalized !== "/callback/:id") return null;

  const provider = context?.params?.id;
  const normalizedProvider = typeof provider === "string" ? provider.toLowerCase() : null;
  return normalizedProvider && socialAuthMethods.includes(normalizedProvider)
    ? (normalizedProvider as AuthMethod)
    : null;
}

function eventTimestamp(event: Stripe.Event): Date {
  return new Date(event.created * 1_000);
}

function subscriptionProperties(
  subscription: Subscription,
): AnalyticsEventMap["subscription_cancel_scheduled"] {
  return {
    billing_interval: subscription.billingInterval ?? null,
    event_source: "stripe_webhook",
    plan: subscription.plan,
    status: subscription.status,
  };
}

export function createServerAnalytics(
  transport: AnalyticsTransport | null,
  onError: AnalyticsErrorHandler = defaultErrorHandler,
) {
  const reportError = (event: string, error: unknown): void => {
    try {
      onError(event, error);
    } catch {
      // Analytics and its diagnostics are observational and must not fail auth or billing.
    }
  };

  const capture = <EventName extends keyof AnalyticsEventMap>(
    sourceId: string,
    distinctId: string,
    event: EventName,
    properties: AnalyticsEventMap[EventName],
    timestamp: Date,
  ): void => {
    if (!transport) return;
    try {
      transport.capture({
        disableGeoip: true,
        distinctId,
        event,
        properties,
        timestamp,
        uuid: analyticsEventUuid(sourceId, event),
      });
    } catch (error) {
      reportError(event, error);
    }
  };

  const subscriptionCallbacks: SubscriptionAnalyticsCallbacks = {
    async onSubscriptionComplete({ event, stripeSubscription, subscription }) {
      const item = stripeSubscription.items.data.find(
        ({ price }) => price.id === subscription.priceId,
      );
      const unitAmount = item?.price.unit_amount;
      const quantity = item?.quantity ?? 1;
      const currency = item?.price.currency.toUpperCase();
      const properties: AnalyticsEventMap["subscription_started"] = {
        ...subscriptionProperties(subscription),
        product: `${IDENTIFIER_PREFIX}_pro`,
        ...(typeof unitAmount === "number" && unitAmount >= 0
          ? { list_price_minor: unitAmount * quantity }
          : {}),
        ...(currency ? { currency } : {}),
      };
      capture(
        event.id,
        subscription.referenceId,
        "subscription_started",
        properties,
        eventTimestamp(event),
      );
    },
    async onSubscriptionCancel({ event, subscription }) {
      capture(
        event.id,
        subscription.referenceId,
        "subscription_cancel_scheduled",
        subscriptionProperties(subscription),
        eventTimestamp(event),
      );
    },
    async onSubscriptionDeleted({ event, subscription }) {
      capture(
        event.id,
        subscription.referenceId,
        "subscription_ended",
        subscriptionProperties(subscription),
        eventTimestamp(event),
      );
    },
  };

  return {
    captureUserSignedUp(input: {
      authMethod: AuthMethod;
      createdAt: Date;
      userId: string;
    }): void {
      capture(
        input.userId,
        input.userId,
        "user_signed_up",
        {
          auth_method: input.authMethod,
          event_source: "auth_database_hook",
        },
        input.createdAt,
      );
    },
    subscriptionCallbacks,
    async shutdown(): Promise<void> {
      if (!transport) return;
      try {
        await transport.shutdown(ANALYTICS_SHUTDOWN_TIMEOUT_MS);
      } catch (error) {
        reportError("shutdown", error);
      }
    },
  };
}

const posthog = env.POSTHOG_PROJECT_TOKEN
  ? new PostHog(env.POSTHOG_PROJECT_TOKEN, {
      host: env.POSTHOG_HOST,
      disableGeoip: true,
      enableExceptionAutocapture: false,
      enableLocalEvaluation: false,
      flushAt: 20,
      flushInterval: 5_000,
    })
  : null;

export const serverAnalytics = createServerAnalytics(posthog);
