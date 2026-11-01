import { describe, expect, test } from "bun:test";
import type Stripe from "stripe";

import {
  buildBillingCatalog,
  resolveStripeBillingConfiguration,
} from "./stripe-billing";

const completeEnvironment = {
  STRIPE_SECRET_KEY: "rk_test_example",
  STRIPE_WEBHOOK_SECRET: "whsec_example",
  STRIPE_PRICE_PRO_MONTHLY: "price_month",
  STRIPE_PRICE_PRO_YEARLY: "price_year",
};

function price(interval: "month" | "year", overrides: object = {}) {
  return {
    id: `price_${interval}`,
    active: true,
    currency: "usd",
    product: "prod_pro",
    recurring: { interval, interval_count: 1 },
    type: "recurring",
    unit_amount: 1_000,
    ...overrides,
  } as unknown as Stripe.Price;
}

describe("Stripe billing configuration", () => {
  test("treats a completely absent configuration as disabled", () => {
    expect(resolveStripeBillingConfiguration({})).toEqual({ configured: false });
  });

  test("fails closed when any Stripe setting is missing", () => {
    expect(() =>
      resolveStripeBillingConfiguration({
        ...completeEnvironment,
        STRIPE_PRICE_PRO_YEARLY: undefined,
      }),
    ).toThrow("STRIPE_PRICE_PRO_YEARLY");
  });

  test("accepts a restricted Stripe key", () => {
    expect(resolveStripeBillingConfiguration(completeEnvironment)).toMatchObject({
      configured: true,
      livemode: false,
      secretKey: "rk_test_example",
    });
  });

  test("reports live mode without exposing or querying the key", () => {
    expect(
      resolveStripeBillingConfiguration({
        ...completeEnvironment,
        STRIPE_SECRET_KEY: "rk_live_example",
      }),
    ).toMatchObject({ configured: true, livemode: true });
  });

  test("accepts a Stripe CLI claimable sandbox key", () => {
    expect(
      resolveStripeBillingConfiguration({
        ...completeEnvironment,
        STRIPE_SECRET_KEY: "rkcs_test_example",
      }),
    ).toMatchObject({
      configured: true,
      livemode: false,
      secretKey: "rkcs_test_example",
    });
  });

  test("rejects an unrecognized Stripe credential family", () => {
    expect(() =>
      resolveStripeBillingConfiguration({
        ...completeEnvironment,
        STRIPE_SECRET_KEY: "secret_example",
      }),
    ).toThrow("STRIPE_SECRET_KEY");
  });

  test("fails closed when production receives a Sandbox key", () => {
    expect(() =>
      resolveStripeBillingConfiguration({
        ...completeEnvironment,
        NODE_ENV: "production",
      }),
    ).toThrow("Stripe Live");
    expect(
      resolveStripeBillingConfiguration({
        ...completeEnvironment,
        NODE_ENV: "production",
        STRIPE_SECRET_KEY: "sk_live_example",
      }),
    ).toMatchObject({ configured: true, livemode: true });
  });

  test("a staging release runs on test keys and refuses Live keys", () => {
    expect(resolveStripeBillingConfiguration({ ...completeEnvironment, NODE_ENV: "production", DEPLOY_STAGE: "staging" }))
      .toMatchObject({ configured: true, livemode: false });
    expect(() =>
      resolveStripeBillingConfiguration({
        ...completeEnvironment,
        NODE_ENV: "production",
        DEPLOY_STAGE: "staging",
        STRIPE_SECRET_KEY: "sk_live_example",
      }),
    ).toThrow("never a Live key");
  });
});

describe("Stripe billing catalog", () => {
  test("returns only safe, price-authoritative display fields", () => {
    expect(
      buildBillingCatalog({
        month: price("month", { unit_amount: 2_000 }),
        year: price("year", { unit_amount: 20_000 }),
      }),
    ).toEqual({
      configured: true,
      unitAmounts: { month: 2_000, year: 20_000 },
    });
  });

  test("rejects catalog drift before it reaches Checkout", () => {
    expect(() =>
      buildBillingCatalog({
        month: price("month", { product: "prod_other" }),
        year: price("year"),
      }),
    ).toThrow("one product");
    expect(() =>
      buildBillingCatalog({
        month: price("year"),
        year: price("year"),
      }),
    ).toThrow("mismatched recurring interval");
    expect(() =>
      buildBillingCatalog({
        month: price("month", { currency: "eur" }),
        year: price("year"),
      }),
    ).toThrow("must use USD");
  });
});
