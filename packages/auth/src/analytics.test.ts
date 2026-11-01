import { describe, expect, test } from "bun:test";
import type { Subscription } from "@better-auth/stripe";
import type { EventMessage } from "posthog-node";
import type Stripe from "stripe";

import {
  analyticsEventUuid,
  createServerAnalytics,
  signupAuthMethodFromContext,
  type AnalyticsTransport,
} from "./analytics";

function transport() {
  const captured: EventMessage[] = [];
  const value: AnalyticsTransport = {
    capture(message) {
      captured.push(message);
    },
    async shutdown() {},
  };
  return { captured, value };
}

function subscription(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: "billing-record-1",
    plan: "pro-yearly",
    referenceId: "user-1",
    status: "active",
    billingInterval: "year",
    ...overrides,
  };
}

describe("server analytics", () => {
  test("derives stable, valid UUIDs for webhook retry deduplication", () => {
    const first = analyticsEventUuid("evt_1", "subscription_started");
    expect(first).toBe(analyticsEventUuid("evt_1", "subscription_started"));
    expect(first).not.toBe(analyticsEventUuid("evt_2", "subscription_started"));
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test("infers only supported auth methods from Better Auth paths", () => {
    expect(signupAuthMethodFromContext({ path: "/sign-up/email" })).toBe("email");
    for (const provider of ["google", "github", "apple"] as const) {
      expect(
        signupAuthMethodFromContext({ path: "/callback/:id", params: { id: provider } }),
      ).toBe(provider);
    }
    expect(
      signupAuthMethodFromContext({ path: "/callback/:id", params: { id: "twitter" } }),
    ).toBeNull();
    expect(signupAuthMethodFromContext({ path: "/admin/create-user" })).toBeNull();
  });

  test("attributes signup to the stable account ID without PII or GeoIP", () => {
    const fake = transport();
    const analytics = createServerAnalytics(fake.value);
    const createdAt = new Date("2026-09-02T00:00:00.000Z");

    analytics.captureUserSignedUp({
      authMethod: "google",
      createdAt,
      userId: "user-1",
    });

    expect(fake.captured).toEqual([
      {
        disableGeoip: true,
        distinctId: "user-1",
        event: "user_signed_up",
        properties: {
          auth_method: "google",
          event_source: "auth_database_hook",
        },
        timestamp: createdAt,
        uuid: analyticsEventUuid("user-1", "user_signed_up"),
      },
    ]);
    expect(fake.captured[0]?.properties).not.toHaveProperty("email");
    expect(fake.captured[0]?.properties).not.toHaveProperty("name");
  });

  test("queues a Stripe-confirmed subscription with price context and retry-safe identity", async () => {
    const fake = transport();
    const analytics = createServerAnalytics(fake.value);
    const event = { id: "evt_checkout", created: 1_788_200_000 } as Stripe.Event;
    const stripeSubscription = {
      items: {
        data: [
          {
            price: { currency: "usd", id: "price_unrelated", unit_amount: 999_999 },
            quantity: 1,
          },
          {
            price: { currency: "usd", id: "price_pro_yearly", unit_amount: 20_000 },
            quantity: 1,
          },
        ],
      },
    } as Stripe.Subscription;

    await analytics.subscriptionCallbacks.onSubscriptionComplete?.(
      {
        event,
        stripeSubscription,
        subscription: subscription({ priceId: "price_pro_yearly" }),
        plan: { name: "pro-yearly" },
      },
      {} as never,
    );

    expect(fake.captured).toEqual([
      expect.objectContaining({
        distinctId: "user-1",
        disableGeoip: true,
        event: "subscription_started",
        properties: expect.objectContaining({
          billing_interval: "year",
          currency: "USD",
          event_source: "stripe_webhook",
          product: "northwind_pro",
          list_price_minor: 20_000,
        }),
        timestamp: new Date(event.created * 1_000),
        uuid: analyticsEventUuid(event.id, "subscription_started"),
      }),
    ]);
    expect(fake.captured[0]?.properties).not.toHaveProperty("subscription_id");
  });

  test("does not let analytics delivery failures fail the Stripe webhook", async () => {
    const failures: string[] = [];
    const analytics = createServerAnalytics(
      {
        capture() {
          throw new Error("network unavailable");
        },
        async shutdown() {},
      },
      (event) => failures.push(event),
    );

    await expect(
      analytics.subscriptionCallbacks.onSubscriptionDeleted?.({
        event: { id: "evt_deleted", created: 1_788_200_000 } as Stripe.Event,
        stripeSubscription: {} as Stripe.Subscription,
        subscription: subscription({ status: "canceled" }),
      }),
    ).resolves.toBeUndefined();
    expect(failures).toEqual(["subscription_ended"]);
  });

  test("does not let analytics capture failures fail signup", () => {
    const failures: string[] = [];
    const analytics = createServerAnalytics(
      {
        capture() {
          throw new Error("storage unavailable");
        },
        async shutdown() {},
      },
      (event) => failures.push(event),
    );

    expect(() =>
      analytics.captureUserSignedUp({
        authMethod: "email",
        createdAt: new Date("2026-09-02T00:00:00.000Z"),
        userId: "user-1",
      }),
    ).not.toThrow();
    expect(failures).toEqual(["user_signed_up"]);
  });

  test("bounds shutdown flushes and isolates transport failures", async () => {
    const failures: string[] = [];
    const shutdownTimeouts: Array<number | undefined> = [];
    const analytics = createServerAnalytics(
      {
        capture() {},
        async shutdown(timeoutMs) {
          shutdownTimeouts.push(timeoutMs);
          throw new Error("ingestion unavailable");
        },
      },
      (event) => failures.push(event),
    );

    await expect(analytics.shutdown()).resolves.toBeUndefined();
    expect(shutdownTimeouts).toEqual([5_000]);
    expect(failures).toEqual(["shutdown"]);
  });

  test("does not let analytics diagnostics fail signup", () => {
    const analytics = createServerAnalytics(
      {
        capture() {
          throw new Error("storage unavailable");
        },
        async shutdown() {},
      },
      () => {
        throw new Error("logger unavailable");
      },
    );

    expect(() =>
      analytics.captureUserSignedUp({
        authMethod: "email",
        createdAt: new Date("2026-09-02T00:00:00.000Z"),
        userId: "user-1",
      }),
    ).not.toThrow();
  });
});
