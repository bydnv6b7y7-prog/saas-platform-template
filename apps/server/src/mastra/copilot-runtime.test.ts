import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { assistantAccessForPlan } from "../billing/assistant-access";
import { ASSISTANT_AGENT_ID } from "@northwind/product/assistant-contracts";

import { COPILOT_RUNTIME_PATH } from "./constants";
import { createCopilotRuntimeApp } from "./copilot-runtime";

const limits = {
  assistantFreePer5Minutes: 5,
  assistantFreePerDay: 5,
  assistantProPer5Minutes: 10,
  assistantProPerDay: 100,
};

function runtimeApp(overrides: Record<string, unknown> = {}, downstream?: Hono) {
  const dependencies = {
    resolvePrincipal: async () => ({ id: "user-1" }),
    getAccess: async () => assistantAccessForPlan("free", limits),
    getModelStatus: () => ({
      provider: "openai-compatible" as const,
      model: "test-model",
      routerModelId: null,
      configured: true,
    }),
    reserveRun: async () => ({
      allowed: true as const,
      reservation: { windows: [] },
    }),
    releaseRun: async () => undefined,
    isPageToolContinuation: async () => false,
    ...overrides,
  };
  const terminal =
    downstream ??
    new Hono().all("*", (c) => c.json({ reached: true }));
  return createCopilotRuntimeApp(dependencies, terminal);
}

const runPath = `${COPILOT_RUNTIME_PATH}/agent/${ASSISTANT_AGENT_ID}/run`;

describe("Copilot runtime request boundary", () => {
  test("maps an authentication outage to an explicit fail-closed response", async () => {
    const app = runtimeApp({
      resolvePrincipal: async () => {
        throw new Error("database unavailable");
      },
    });

    const response = await app.request(`http://localhost${COPILOT_RUNTIME_PATH}/info`);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "auth_unavailable" });
  });

  test("does not enter billing or runtime work without a session", async () => {
    let accessRead = false;
    const app = runtimeApp({
      resolvePrincipal: async () => null,
      getAccess: async () => {
        accessRead = true;
        return assistantAccessForPlan("free", limits);
      },
    });

    const response = await app.request(`http://localhost${COPILOT_RUNTIME_PATH}/info`);

    expect(response.status).toBe(401);
    expect(accessRead).toBe(false);
  });

  test("passes the authenticated principal to entitlement resolution", async () => {
    let receivedPrincipal: unknown;
    const app = runtimeApp({
      resolvePrincipal: async () => ({ id: "admin-1", role: "admin" }),
      getAccess: async (principal: unknown) => {
        receivedPrincipal = principal;
        return {
          plan: "pro",
          accessSource: "admin",
          limits: { per5Minutes: 10, perDay: 100 },
        };
      },
    });

    const response = await app.request(`http://localhost${COPILOT_RUNTIME_PATH}/info`);

    expect(response.status).toBe(200);
    expect(receivedPrincipal).toEqual({ id: "admin-1", role: "admin" });
  });

  test("keeps quota persistence failures separate from downstream failures", async () => {
    const app = runtimeApp({
      reserveRun: async () => {
        throw new Error("quota store unavailable");
      },
    });

    const response = await app.request(`http://localhost${runPath}`, {
      method: "POST",
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: "assistant_unavailable",
      message: "Assistant usage could not be recorded.",
    });
  });

  for (const status of [400, 500] as const) {
    test(`refunds a reservation when downstream setup returns ${status}`, async () => {
      let refunds = 0;
      const downstream = new Hono().all("*", (c) =>
        c.json({ error: "runtime did not start" }, status),
      );
      const app = runtimeApp(
        {
          releaseRun: async () => {
            refunds += 1;
          },
        },
        downstream,
      );

      const response = await app.request(`http://localhost${runPath}`, {
        method: "POST",
      });

      expect(response.status).toBe(status);
      expect(refunds).toBe(1);
    });
  }

  test("does not refund a successfully handed-off run", async () => {
    let refunds = 0;
    const app = runtimeApp({
      releaseRun: async () => {
        refunds += 1;
      },
    });

    const response = await app.request(`http://localhost${runPath}`, {
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(refunds).toBe(0);
  });

  test("does not charge the verified follow-up for a frontend page tool", async () => {
    let reservations = 0;
    const app = runtimeApp({
      isPageToolContinuation: async () => true,
      reserveRun: async () => {
        reservations += 1;
        return {
          allowed: true as const,
          reservation: { windows: [] },
        };
      },
    });

    const response = await app.request(`http://localhost${runPath}`, {
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(reservations).toBe(0);
  });
});
