import { auth } from "@northwind/auth";
import { Hono } from "hono";

import { captureRequestError } from "../logging";
import { getCopilotModelStatus } from "../mastra/model";
import {
  getAssistantAccess,
  getAssistantUsage,
  type AssistantAccess,
  type AssistantPrincipal,
} from "./assistant-access";

type AssistantUsageDependencies = {
  getSession: (headers: Headers) => Promise<{ user: AssistantPrincipal } | null>;
  getAccess: (principal: AssistantPrincipal) => Promise<AssistantAccess>;
  getUsage: typeof getAssistantUsage;
  isConfigured: () => boolean;
};

const defaultDependencies: AssistantUsageDependencies = {
  getSession: (headers) => auth.api.getSession({ headers }),
  getAccess: getAssistantAccess,
  getUsage: getAssistantUsage,
  isConfigured: () => getCopilotModelStatus().configured,
};

export function createAssistantUsageApp(
  overrides: Partial<AssistantUsageDependencies> = {},
) {
  const dependencies = { ...defaultDependencies, ...overrides };
  return new Hono().get("/api/assistant/usage", async (c) => {
    c.header("Cache-Control", "private, no-store");
    try {
      const session = await dependencies.getSession(c.req.raw.headers);
      if (!session) {
        return c.json(
          { error: { code: "unauthorized", message: "Sign in to use Northwind AI." } },
          401,
        );
      }
      const access = await dependencies.getAccess(session.user);
      return c.json({ ...await dependencies.getUsage(session.user.id, access), configured: dependencies.isConfigured() });
    } catch (error) {
      captureRequestError(error, { operation: "assistant_usage" });
      return c.json(
        {
          error: {
            code: "assistant_usage_unavailable",
            message: "Assistant usage could not be loaded.",
          },
        },
        503,
      );
    }
  });
}

export const assistantUsageApp = createAssistantUsageApp();
