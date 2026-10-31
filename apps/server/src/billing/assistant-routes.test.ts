import { describe, expect, test } from "bun:test";

import { assistantAccessForPlan } from "./assistant-access";
import { createAssistantUsageApp } from "./assistant-routes";

const limits = {
  assistantFreePer5Minutes: 5,
  assistantFreePerDay: 5,
  assistantProPer5Minutes: 10,
  assistantProPerDay: 100,
};

describe("assistant usage route", () => {
  test("requires an authenticated account", async () => {
    const app = createAssistantUsageApp({ getSession: async () => null });

    const response = await app.request("/api/assistant/usage");

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  test("returns the safe free-plan quota projection", async () => {
    const access = assistantAccessForPlan("free", limits);
    const app = createAssistantUsageApp({
      getSession: async () => ({ user: { id: "user-private" } }),
      getAccess: async (principal) => {
        expect(principal).toEqual({ id: "user-private" });
        return access;
      },
      getUsage: async (userId, receivedAccess) => {
        expect(userId).toBe("user-private");
        expect(receivedAccess).toEqual(access);
        return {
          plan: "free",
          accessSource: "free",
          historyEnabled: true,
          limits: access.limits,
          daily: {
            used: 2,
            remaining: 3,
            resetAt: "2026-08-30T00:00:00.000Z",
          },
        };
      },
    });

    const response = await app.request("/api/assistant/usage");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      plan: "free",
      accessSource: "free",
      historyEnabled: true,
      limits: { per5Minutes: 5, perDay: 5 },
      daily: {
        used: 2,
        remaining: 3,
        resetAt: "2026-08-30T00:00:00.000Z",
      },
    });
    expect(JSON.stringify(body)).not.toContain("user-private");
  });

  test("passes the authenticated role into the entitlement decision", async () => {
    const app = createAssistantUsageApp({
      getSession: async () => ({ user: { id: "admin-1", role: "admin" } }),
      getAccess: async (principal) => {
        expect(principal).toEqual({ id: "admin-1", role: "admin" });
        return {
          plan: "pro",
          accessSource: "admin",
          limits: { per5Minutes: 10, perDay: 100 },
        };
      },
      getUsage: async (_userId, access) => ({
        plan: access.plan,
        accessSource: access.accessSource,
        historyEnabled: true,
        limits: access.limits,
        daily: {
          used: 0,
          remaining: 100,
          resetAt: "2026-08-31T00:00:00.000Z",
        },
      }),
    });

    const response = await app.request("/api/assistant/usage");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      plan: "pro",
      accessSource: "admin",
    });
  });

  test("fails closed when quota state cannot be read", async () => {
    const app = createAssistantUsageApp({
      getSession: async () => ({ user: { id: "user-1" } }),
      getAccess: async () => {
        throw new Error("database unavailable");
      },
    });

    const response = await app.request("/api/assistant/usage");

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: "assistant_usage_unavailable",
        message: "Assistant usage could not be loaded.",
      },
    });
  });
});
