import { describe, expect, it } from "bun:test";
import { MASTRA_RESOURCE_ID_KEY } from "@mastra/core/request-context";

import { withRequestLog } from "../logging";
import { ASSISTANT_AGENT_ID } from "@northwind/product/assistant-contracts";

import { COPILOT_RUNTIME_PATH, MASTRA_SCHEMA_NAME } from "./constants";
import { agUiAgentRunner } from "./agent-runner";
import { copilotRuntimeApp } from "./copilot-runtime";
import { mastra } from "./index";
import { PostgresAgentRunner } from "./postgres-agent-runner";
import {
  assistantRequestContextSchema,
  createUserRequestContext,
} from "./request-context";
import { mastraStorage } from "./storage";

describe("Mastra + CopilotKit integration", () => {
  it("registers the product assistant with memory, storage, and observability", async () => {
    const agent = mastra.getAgent(ASSISTANT_AGENT_ID);
    // The thread API and account deletion read and erase the assistant's memory.
    const memory = await agent.getMemory({
      requestContext: createUserRequestContext("memory-scope-test"),
    });

    expect(memory).toBeDefined();
    expect(mastra.getStorage()?.id).toBe(mastraStorage.id);
    expect(mastra.observability).toBeDefined();
    expect(MASTRA_SCHEMA_NAME).toBe("mastra");
    expect(agUiAgentRunner).toBeInstanceOf(PostgresAgentRunner);
  });

  it("requires authentication before model work", async () => {
    const response = await copilotRuntimeApp.request(
      `http://localhost${COPILOT_RUNTIME_PATH}/info`,
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "unauthorized" });
  });

  it("separates memory ownership from safe trace correlation", async () => {
    await withRequestLog("req-safe", async () => {
      const requestContext = createUserRequestContext(
        "user-1",
        new Date("2026-08-31T23:59:59.000Z"),
      );

      expect(requestContext.getRaw(MASTRA_RESOURCE_ID_KEY)).toBe("user-1");
      expect(requestContext.get("requestId")).toBe("req-safe");
      expect(requestContext.get("requestStartedAt")).toBe(
        "2026-08-31T23:59:59.000Z",
      );
      expect(requestContext.all).not.toHaveProperty("userId");
      expect(
        assistantRequestContextSchema.safeParse(requestContext.all).success,
      ).toBe(true);
    });
  });
});
