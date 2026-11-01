import { describe, expect, test } from "bun:test";

import { createBillingApp } from "./routes";

describe("billing catalog route", () => {
  test("returns a cacheable public DTO without Stripe identifiers", async () => {
    const app = createBillingApp({
      getCatalog: async () => ({
        configured: true,
        unitAmounts: { month: 1_500, year: 15_000 },
      }),
    });

    const response = await app.request("/api/billing/catalog");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("max-age=300");
    const body = await response.json();
    expect(body).toEqual({
      configured: true,
      unitAmounts: { month: 1_500, year: 15_000 },
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("price_");
    expect(serialized).not.toContain("sk_");
  });

  test("fails closed without exposing an upstream error", async () => {
    const app = createBillingApp({
      getCatalog: async () => {
        throw new Error("sk_live_sensitive");
      },
    });

    const response = await app.request("/api/billing/catalog");
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: "Billing catalog is temporarily unavailable",
    });
  });
});

describe("billing status route", () => {
  test("requires an authenticated session", async () => {
    const app = createBillingApp({
      getSession: async () => null,
    });

    const response = await app.request("/api/billing/status");
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ error: "Unauthorized" });
  });

  test("derives ownership from the session and returns only the safe projection", async () => {
    let requestedUserId: string | null = null;
    const app = createBillingApp({
      getSession: async () => ({ user: { id: "user_session" } }),
      getStatus: async (userId) => {
        requestedUserId = userId;
        return {
          configured: true,
          accessSource: "free",
          subscription: {
            plan: "pro-monthly",
            status: "past_due",
            interval: "month",
            periodEnd: "2026-09-01T00:00:00.000Z",
            cancelAtPeriodEnd: false,
            grantsAccess: false,
            needsAttention: true,
          },
        };
      },
    });

    const response = await app.request("/api/billing/status?userId=another_user");
    expect(response.status).toBe(200);
    expect(requestedUserId).toBe("user_session");
    const body = await response.text();
    expect(body).toContain("past_due");
    expect(body).not.toContain("user_session");
    expect(body).not.toContain("another_user");
    expect(body).not.toContain("stripeSubscriptionId");
  });

  test("projects administrator access without inventing a Stripe subscription", async () => {
    const app = createBillingApp({
      getSession: async () => ({ user: { id: "admin-1", role: "admin" } }),
      getStatus: async () => ({
        configured: true,
        accessSource: "free",
        subscription: null,
      }),
      isAdmin: () => true,
    });

    const response = await app.request("/api/billing/status");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      configured: true,
      accessSource: "admin",
      subscription: null,
    });
  });

  test("fails closed without leaking database errors", async () => {
    const app = createBillingApp({
      getSession: async () => ({ user: { id: "user_session" } }),
      getStatus: async () => {
        throw new Error("postgres://sensitive");
      },
    });

    const response = await app.request("/api/billing/status");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Subscription status is temporarily unavailable",
    });
  });
});
