import { describe, expect, test } from "bun:test";

import {
  assistantUsageStatusSchema,
  annualBillingComparison,
  billingCatalogSchema,
  canStartCheckout,
  formatUsdAmount,
  getBillingIntervalForPlan,
  grantsPaidAccess,
  paidPlans,
  planLabel,
  summarizeBillingStatus,
  userBillingStatusSchema,
  withAdminAccess,
} from ".";

describe("billing contract", () => {
  test("validates every public HTTP projection at runtime", () => {
    expect(
      billingCatalogSchema.parse({
        configured: true,
        unitAmounts: { month: 1_500, year: 15_000 },
      }),
    ).toEqual({
      configured: true,
      unitAmounts: { month: 1_500, year: 15_000 },
    });
    expect(
      userBillingStatusSchema.parse({ configured: false, subscription: null }),
    ).toEqual({ configured: false, accessSource: "free", subscription: null });
    expect(
      assistantUsageStatusSchema.parse({
        plan: "free",
        accessSource: "free",
        historyEnabled: true,
        limits: { per5Minutes: 5, perDay: 5 },
        daily: {
          used: 1,
          remaining: 4,
          resetAt: "2026-08-31T00:00:00.000Z",
        },
      }),
    ).toMatchObject({
      plan: "free",
      accessSource: "free",
      daily: { remaining: 4 },
    });
  });

  test("rejects malformed public HTTP projections", () => {
    expect(() =>
      billingCatalogSchema.parse({
        configured: true,
        unitAmounts: { month: -1, year: 15_000 },
      }),
    ).toThrow();
    expect(() =>
      assistantUsageStatusSchema.parse({
        plan: "free",
        accessSource: "free",
        historyEnabled: true,
        limits: { per5Minutes: 5, perDay: 5 },
        daily: { used: 1, remaining: 4, resetAt: "tomorrow" },
      }),
    ).toThrow();
  });

  test("maps each supported interval to one stable Better Auth plan id", () => {
    expect(getBillingIntervalForPlan(paidPlans.month.id)).toBe("month");
    expect(getBillingIntervalForPlan(paidPlans.year.id)).toBe("year");
    expect(getBillingIntervalForPlan("legacy-plan")).toBeNull();
  });

  test("formats USD Stripe minor units without redundant zeroes", () => {
    expect(formatUsdAmount(1_500)).toBe("$15");
    expect(formatUsdAmount(20_000 / 12)).toBe("$16.67");
  });

  test("derives transparent annual savings from Stripe-authoritative amounts", () => {
    expect(annualBillingComparison(2_000, 20_000)).toEqual({
      monthlyEquivalentUnitAmount: 20_000 / 12,
      savingsUnitAmount: 4_000,
      savingsPercent: 17,
    });
  });

  test("uses stable plan labels and a safe legacy fallback", () => {
    expect(planLabel("pro-monthly")).toBe("Monthly");
    expect(planLabel("legacy")).toBe("Pro");
  });

  test("grants access only for active or trialing known paid plans", () => {
    expect(grantsPaidAccess({ plan: paidPlans.month.id, status: "active" })).toBe(true);
    expect(
      grantsPaidAccess({
        plan: paidPlans.month.id,
        status: "active",
        cancelAtPeriodEnd: true,
      }),
    ).toBe(true);
    expect(grantsPaidAccess({ plan: paidPlans.year.id, status: "trialing" })).toBe(true);
    expect(grantsPaidAccess({ plan: paidPlans.year.id, status: "past_due" })).toBe(false);
    expect(grantsPaidAccess({ plan: paidPlans.year.id, status: "canceled" })).toBe(false);
    expect(grantsPaidAccess({ plan: "unknown", status: "active" })).toBe(false);
  });

  test("keeps payment-problem subscriptions in management instead of new checkout", () => {
    expect(
      summarizeBillingStatus([
        {
          plan: paidPlans.month.id,
          status: "past_due",
          periodEnd: "2026-09-01T00:00:00.000Z",
        },
      ]),
    ).toEqual({
      configured: true,
      accessSource: "free",
      subscription: {
        plan: paidPlans.month.id,
        status: "past_due",
        interval: "month",
        periodEnd: "2026-09-01T00:00:00.000Z",
        cancelAtPeriodEnd: false,
        grantsAccess: false,
        needsAttention: true,
      },
    });
  });

  test("allows retrying a Checkout that never created a Stripe subscription", () => {
    const status = summarizeBillingStatus([
      {
        plan: paidPlans.year.id,
        status: "incomplete",
        stripeSubscriptionId: null,
      },
    ]);

    expect(status).toEqual({
      configured: true,
      accessSource: "free",
      subscription: null,
    });
    expect(canStartCheckout(status)).toBe(true);
  });

  test("keeps a real incomplete Stripe subscription in management", () => {
    const status = summarizeBillingStatus([
      {
        plan: paidPlans.year.id,
        status: "incomplete",
        stripeSubscriptionId: "sub_incomplete",
      },
    ]);

    expect(status.subscription).toMatchObject({
      status: "incomplete",
      grantsAccess: false,
      needsAttention: true,
    });
    expect(status).not.toHaveProperty("subscription.stripeSubscriptionId");
    expect(canStartCheckout(status)).toBe(false);
  });

  test("fails closed for a future non-terminal Stripe status", () => {
    expect(
      summarizeBillingStatus([
        {
          plan: paidPlans.year.id,
          status: "future_status",
          periodEnd: "not-a-date",
        },
      ]),
    ).toEqual({
      configured: true,
      accessSource: "free",
      subscription: {
        plan: paidPlans.year.id,
        status: "future_status",
        interval: "year",
        periodEnd: null,
        cancelAtPeriodEnd: false,
        grantsAccess: false,
        needsAttention: true,
      },
    });
  });

  test("marks an active but unknown plan for attention instead of implying access", () => {
    expect(summarizeBillingStatus([{ plan: "legacy", status: "active" }])).toEqual({
      configured: true,
      accessSource: "free",
      subscription: {
        plan: "legacy",
        status: "active",
        interval: null,
        periodEnd: null,
        cancelAtPeriodEnd: false,
        grantsAccess: false,
        needsAttention: true,
      },
    });
  });

  test("allows a fresh checkout after a subscription has actually ended", () => {
    const status = summarizeBillingStatus([
      { plan: paidPlans.month.id, status: "canceled" },
      { plan: "legacy", status: "incomplete_expired" },
    ]);
    expect(status.subscription).toBeNull();
    expect(canStartCheckout(status)).toBe(true);
  });

  test("allows checkout only when billing is configured and no subscription is managed", () => {
    expect(
      canStartCheckout({
        configured: false,
        accessSource: "free",
        subscription: null,
      }),
    ).toBe(false);
    expect(
      canStartCheckout(
        summarizeBillingStatus([{ plan: paidPlans.month.id, status: "past_due" }]),
      ),
    ).toBe(false);
  });

  test("keeps administrator access separate from Stripe subscription state", () => {
    const status = withAdminAccess(
      summarizeBillingStatus([], true),
    );

    expect(status).toEqual({
      configured: true,
      accessSource: "admin",
      subscription: null,
    });
    expect(canStartCheckout(status)).toBe(false);
  });
});
