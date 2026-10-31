import { auth } from "@northwind/auth";
import { RunAgentInputSchema } from "@ag-ui/core/schemas";
import { MastraAgent } from "@ag-ui/mastra";
import {
  CopilotRuntime,
  createCopilotHonoHandler,
} from "@copilotkit/runtime/v2";
import { Hono } from "hono";

import {
  getAssistantAccess,
  releaseAssistantRun,
  reserveAssistantRun,
  type AssistantAccess,
  type AssistantPrincipal,
} from "../billing/assistant-access";
import { captureRequestError } from "../logging";
import { agUiAgentRunner } from "./agent-runner";
import { ASSISTANT_AGENT_ID } from "@northwind/product/assistant-contracts";

import { COPILOT_RUNTIME_PATH } from "./constants";
import { mastra } from "./index";
import { getCopilotModelStatus } from "./model";
import { createUserRequestContext } from "./request-context";
import {
  attachMastraRunLifecycle,
  bindMastraRunAbortSignal,
} from "./run-lifecycle";
import {
  assistantRunQuotaContext,
  copilotUserContext,
  scopedAssistantThreadId,
  UserScopedAgentRunner,
} from "./user-scoped-runner";

type LocalMastraAgentConfig = ConstructorParameters<typeof MastraAgent>[0];
type RuntimeAgents = ConstructorParameters<typeof CopilotRuntime>[0]["agents"];
type CopilotRuntimeEnv = {
  Variables: {
    assistantAccess: AssistantAccess;
    assistantUserId: string;
  };
};

type CopilotRuntimeDependencies = {
  resolvePrincipal: (request: Request) => Promise<AssistantPrincipal | null>;
  getAccess: typeof getAssistantAccess;
  getModelStatus: typeof getCopilotModelStatus;
  reserveRun: typeof reserveAssistantRun;
  releaseRun: typeof releaseAssistantRun;
  isPageToolContinuation: (
    request: Request,
    userId: string,
  ) => Promise<boolean>;
};

async function resolvePrincipal(
  request: Request,
): Promise<AssistantPrincipal | null> {
  const session = await auth.api.getSession({ headers: request.headers });
  return session?.user ?? null;
}

function fail(
  status: 401 | 429 | 503,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): Response {
  return Response.json({ error: code, message, ...details }, { status });
}

const agentsForRequest = async (_input: { request: Request }) => {
  const userId = copilotUserContext.getStore();
  if (!userId) throw fail(401, "unauthorized", "Sign in to use the App Store assistant.");

  const requestContext = createUserRequestContext(userId);

  const modelStatus = getCopilotModelStatus();

  const localAgent = mastra.getAgent(ASSISTANT_AGENT_ID);
  const agent = new MastraAgent({
    // @ag-ui/mastra carries the same exact Mastra version through a Zod v3
    // peer graph, so Bun emits a second private-type identity. The runtime
    // objects are API-identical; keep the cast isolated at this adapter edge.
    agent: bindMastraRunAbortSignal(
      localAgent,
      requestContext,
    ) as unknown as LocalMastraAgentConfig["agent"],
    agentId: ASSISTANT_AGENT_ID,
    resourceId: userId,
    requestContext:
      requestContext as unknown as LocalMastraAgentConfig["requestContext"],
    tracingOptions: {
      metadata: {
        transport: "copilotkit-ag-ui",
        modelProvider: modelStatus.provider,
        modelId: modelStatus.model,
      },
    },
  });

  return {
    [ASSISTANT_AGENT_ID]: attachMastraRunLifecycle(agent, requestContext),
  };
};

async function isPageToolContinuation(
  request: Request,
  userId: string,
): Promise<boolean> {
  let input;
  try {
    input = RunAgentInputSchema.parse(await request.clone().json());
  } catch {
    return false;
  }
  const message = input.messages.at(-1);
  if (!message || message.role !== "tool") return false;

  return agUiAgentRunner.hasPendingPageToolCall(
    scopedAssistantThreadId(userId, input.threadId),
    message.toolCallId,
  );
}

const runtime = new CopilotRuntime({
  // CopilotKit 1.69 pins AG-UI 0.0.57 while @ag-ui/mastra 1.1.2 uses the
  // backwards-compatible 0.0.58 AbstractAgent. Keep that identity cast here.
  agents: agentsForRequest as unknown as RuntimeAgents,
  forwardHeaders: {
    deny: ["authorization", "cookie"],
    denyPrefixes: ["x-"],
  },
  exposeMemoryRoutes: false,
  runner: new UserScopedAgentRunner(agUiAgentRunner),
});

const agUiRuntimeApp = createCopilotHonoHandler({
  runtime,
  basePath: COPILOT_RUNTIME_PATH,
  mode: "multi-route",
});

const defaultDependencies: CopilotRuntimeDependencies = {
  resolvePrincipal,
  getAccess: getAssistantAccess,
  getModelStatus: getCopilotModelStatus,
  reserveRun: reserveAssistantRun,
  releaseRun: releaseAssistantRun,
  isPageToolContinuation,
};

export function createCopilotRuntimeApp(
  dependencies: CopilotRuntimeDependencies = defaultDependencies,
  downstream: Hono = agUiRuntimeApp,
) {
  const app = new Hono<CopilotRuntimeEnv>();
  app.use(`${COPILOT_RUNTIME_PATH}/*`, async (c, next) => {
    if (c.req.method === "OPTIONS") return next();

    let principal: AssistantPrincipal | null;
    try {
      principal = await dependencies.resolvePrincipal(c.req.raw);
    } catch (error) {
      captureRequestError(error, { operation: "assistant_auth" });
      return fail(503, "auth_unavailable", "Assistant access could not be verified.");
    }
    if (!principal) {
      return fail(401, "unauthorized", "Sign in to use the App Store assistant.");
    }
    const userId = principal.id;

    let assistantAccess: AssistantAccess;
    try {
      assistantAccess = await dependencies.getAccess(principal);
    } catch (error) {
      captureRequestError(error, { operation: "assistant_entitlement" });
      return fail(503, "billing_unavailable", "Assistant access could not be verified.");
    }

    const modelStatus = dependencies.getModelStatus();
    if (!modelStatus.configured) {
      return fail(503, "copilot_unconfigured", "The App Store assistant is not configured.");
    }

    c.set("assistantUserId", userId);
    c.set("assistantAccess", assistantAccess);
    return copilotUserContext.run(userId, next);
  });
  app.use(
    `${COPILOT_RUNTIME_PATH}/agent/:agentId/run`,
    async (c, next) => {
      try {
        if (
          await dependencies.isPageToolContinuation(
            c.req.raw,
            c.get("assistantUserId"),
          )
        ) {
          return next();
        }
      } catch (error) {
        captureRequestError(error, {
          operation: "assistant_continuation_verification",
        });
        return fail(
          503,
          "assistant_unavailable",
          "Assistant continuation could not be verified.",
        );
      }

      let decision: Awaited<ReturnType<typeof reserveAssistantRun>>;
      try {
        decision = await dependencies.reserveRun(
          c.get("assistantUserId"),
          c.get("assistantAccess"),
        );
      } catch (error) {
        captureRequestError(error, { operation: "assistant_usage_reservation" });
        return fail(
          503,
          "assistant_unavailable",
          "Assistant usage could not be recorded.",
        );
      }
      if (!decision.allowed) {
        const daily = decision.reason === "daily";
        return fail(
          429,
          "assistant_limit_reached",
          daily
            ? "The daily Northwind AI limit has been reached."
            : "Northwind AI is receiving requests too quickly.",
          {
            limit: decision.reason,
            plan: c.get("assistantAccess").plan,
            resetAt: decision.resetAt,
          },
        );
      }

      let refundPromise: Promise<void> | null = null;
      const refund = () => {
        refundPromise ??= dependencies.releaseRun(decision.reservation);
        return refundPromise;
      };
      try {
        await assistantRunQuotaContext.run({ refund }, next);
        const response = c.res;
        if (!response.ok) {
          await refund().catch(() => undefined);
        }
        return response;
      } catch (error) {
        await refund().catch(() => undefined);
        throw error;
      }
    },
  );
  app.route("/", downstream);
  return app;
}

export const copilotRuntimeApp = createCopilotRuntimeApp();
