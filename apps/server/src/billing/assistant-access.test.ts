import { describe, expect, test } from "bun:test";
import type { OperationalSettings } from "@northwind/env/operational-settings";

import {
  assistantAccessForAdmin,
  assistantAccessForPlan,
  getAssistantAccess,
  getAssistantUsage,
  reserveAssistantRun,
} from "./assistant-access";

const limits = {
  assistantFreePer5Minutes: 5,
  assistantFreePerDay: 5,
  assistantProPer5Minutes: 10,
  assistantProPerDay: 100,
};

const settings: OperationalSettings = {
  ...limits,
};

function snapshot(values: OperationalSettings) {
  return { values, revision: 1, source: "database" as const, updatedAt: null, updatedBy: null };
}

const readSettings = async () => snapshot(settings);

describe("assistant subscription access", () => {
  test("maps free and paid users to explicit plan limits", async () => {
    expect(assistantAccessForPlan("free", limits)).toEqual({
      plan: "free",
      accessSource: "free",
      limits: { per5Minutes: 5, perDay: 5 },
    });
    expect(assistantAccessForPlan("pro", limits)).toEqual({
      plan: "pro",
      accessSource: "subscription",
      limits: { per5Minutes: 10, perDay: 100 },
    });
    expect(assistantAccessForAdmin(limits)).toEqual({
      plan: "pro",
      accessSource: "admin",
      limits: { per5Minutes: 10, perDay: 100 },
    });

    const free = await getAssistantAccess(
      { id: "user-1" },
      async () => ({
        configured: false,
        accessSource: "free",
        subscription: null,
      }),
      readSettings,
    );
    expect(free.plan).toBe("free");

    const pro = await getAssistantAccess(
      { id: "user-1" },
      async () => ({
        configured: true,
        accessSource: "subscription",
        subscription: {
          plan: "pro-monthly",
          status: "active",
          interval: "month",
          periodEnd: null,
          cancelAtPeriodEnd: false,
          grantsAccess: true,
          needsAttention: false,
        },
      }),
      readSettings,
    );
    expect(pro.plan).toBe("pro");
    expect(pro.accessSource).toBe("subscription");
  });

  test("grants admin access without reading or inventing a Stripe subscription", async () => {
    let billingReads = 0;
    const access = await getAssistantAccess(
      { id: "admin-1", role: "admin" },
      async () => {
        billingReads += 1;
        return {
          configured: true,
          accessSource: "free",
          subscription: null,
        };
      },
      readSettings,
    );

    expect(access).toEqual({
      plan: "pro",
      accessSource: "admin",
      limits: { per5Minutes: 10, perDay: 100 },
    });
    expect(billingReads).toBe(0);
  });

  test("keeps conversation history available regardless of plan", async () => {
    const usage = await getAssistantUsage(
      "user-1",
      assistantAccessForPlan("free", limits),
      async () => ({
        used: 0,
        remaining: 5,
        resetAt: new Date("2026-08-31T00:00:00.000Z"),
      }),
    );

    expect(usage.historyEnabled).toBe(true);
    expect(usage.accessSource).toBe("free");
  });

  test("applies edits to the next request while a current run retains its quota snapshot", async () => {
    const current = { ...settings };
    let reads = 0;
    const reader = async () => {
      reads += 1;
      return snapshot(current);
    };
    const readStatus = async () => ({
      configured: false,
      accessSource: "free" as const,
      subscription: null,
    });

    const runningAccess = await getAssistantAccess({ id: "user-1" }, readStatus, reader);
    current.assistantFreePer5Minutes = 2;
    current.assistantFreePerDay = 3;
    const nextAccess = await getAssistantAccess({ id: "user-1" }, readStatus, reader);
    expect(nextAccess.limits).toEqual({ per5Minutes: 2, perDay: 3 });

    const reservedLimits: number[] = [];
    const decision = await reserveAssistantRun("user-1", runningAccess, async (input) => {
      reservedLimits.push(input.countLimit);
      return {
        subjectHash: input.subjectHash,
        action: input.action,
        windowSeconds: input.windowMs / 1_000,
        bucketStartedAt: new Date(0),
        costUnits: input.costUnits,
      };
    });
    expect(decision.allowed).toBe(true);
    expect(reservedLimits).toEqual([5, 5]);
    expect(reads).toBe(2);

    const usage = await getAssistantUsage("user-1", nextAccess, async (input) => {
      expect(input.countLimit).toBe(3);
      return { used: 1, remaining: 2, resetAt: new Date(0) };
    });
    expect(usage.limits).toEqual({ per5Minutes: 2, perDay: 3 });
    expect(usage.daily.remaining).toBe(2);
    expect(reads).toBe(2);
  });

  test("reads the new Pro limits for each admin request without querying subscriptions", async () => {
    const current = { ...settings };
    const reader = async () => snapshot(current);
    const readStatus = async (): Promise<never> => {
      throw new Error("admins do not require a billing query");
    };
    const principal = { id: "admin-1", role: "admin" };
    const initial = await getAssistantAccess(principal, readStatus, reader);
    current.assistantProPer5Minutes = 15;
    current.assistantProPerDay = 200;
    const updated = await getAssistantAccess(principal, readStatus, reader);
    expect(initial.limits).toEqual({ per5Minutes: 10, perDay: 100 });
    expect(updated.limits).toEqual({ per5Minutes: 15, perDay: 200 });
    expect(updated.accessSource).toBe("admin");
  });

  test("fails closed if operational settings cannot be read", async () => {
    await expect(getAssistantAccess({ id: "admin-1", role: "admin" }, undefined, async () => {
      throw new Error("settings unavailable");
    })).rejects.toThrow("settings unavailable");
  });

  test("reserves burst and daily limits without storing the raw user id", async () => {
    const windows: number[] = [];
    const subjectHashes: string[] = [];
    const access = assistantAccessForPlan("free", limits);
    const decision = await reserveAssistantRun("user-private", access, async (input) => {
      expect(input.action).toBe("assistant_run");
      windows.push(input.windowMs);
      subjectHashes.push(input.subjectHash);
      return {
        subjectHash: input.subjectHash,
        action: input.action,
        windowSeconds: input.windowMs / 1_000,
        bucketStartedAt: new Date(0),
        costUnits: input.costUnits,
      };
    });

    expect(decision.allowed).toBe(true);
    expect(windows).toEqual([5 * 60 * 1_000, 24 * 60 * 60 * 1_000]);
    expect(subjectHashes.every((hash) => hash !== "user-private")).toBe(true);
  });

  test("does not reserve the daily allowance after the burst limit is reached", async () => {
    let calls = 0;
    const decision = await reserveAssistantRun(
      "user-1",
      assistantAccessForPlan("free", limits),
      async () => {
        calls += 1;
        return null;
      },
    );

    expect(decision).toMatchObject({ allowed: false, reason: "burst" });
    expect(calls).toBe(1);
  });

  test("releases the burst reservation when the daily limit rejects the run", async () => {
    let calls = 0;
    let released = 0;
    const decision = await reserveAssistantRun(
      "user-1",
      assistantAccessForPlan("free", limits),
      async (input) => {
        calls += 1;
        if (calls === 2) return null;
        return {
          subjectHash: input.subjectHash,
          action: input.action,
          windowSeconds: input.windowMs / 1_000,
          bucketStartedAt: new Date(0),
          costUnits: input.costUnits,
        };
      },
      async () => {
        released += 1;
      },
    );

    expect(decision).toMatchObject({ allowed: false, reason: "daily" });
    expect(released).toBe(1);
  });
});
