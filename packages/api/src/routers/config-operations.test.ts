import { describe, expect, test } from "bun:test";
import { OPERATIONAL_SETTINGS_DEFAULTS } from "@northwind/env/operational-settings";

import type { Context } from "../context";
import { operationsRouter } from "./config-operations";

const context = (role?: string): Context => ({
  auth: null,
  ip: "test",
  session: role ? { user: { id: "operations-test-user", role } } as Context["session"] : null,
});

describe("operational settings permissions", () => {
  for (const [role, code] of [[undefined, "UNAUTHORIZED"], ["user", "FORBIDDEN"]] as const) {
    test(`protects reads, history and updates for ${role ?? "anonymous"}`, async () => {
      const caller = operationsRouter.createCaller(context(role));
      await expect(caller.overview()).rejects.toMatchObject({ code });
      await expect(caller.history()).rejects.toMatchObject({ code });
      await expect(caller.update({ expectedRevision: 0, values: OPERATIONAL_SETTINGS_DEFAULTS })).rejects.toMatchObject({ code });
    });
  }

  test("validates the complete snapshot and revision before database access", async () => {
    const caller = operationsRouter.createCaller(context("admin"));
    await expect(caller.update({ expectedRevision: -1, values: OPERATIONAL_SETTINGS_DEFAULTS }))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller.update({ expectedRevision: 0, values: { ...OPERATIONAL_SETTINGS_DEFAULTS, assistantFreePerDay: 0.5 } }))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
