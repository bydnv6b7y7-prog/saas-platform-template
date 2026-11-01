import { auth } from "@northwind/auth";
import { normalizeAssistantThreadTitle } from "@northwind/api/assistant";
import type { RequestContext } from "@mastra/core/request-context";
import { Hono } from "hono";
import { ZodError, z } from "zod";

import { captureRequestError } from "../logging";
import { agUiAgentRunner } from "./agent-runner";
import { ASSISTANT_AGENT_ID } from "@northwind/product/assistant-contracts";
import { mastra } from "./index";
import {
  createUserRequestContext,
  type AssistantRequestContext,
} from "./request-context";
import { scopedAssistantThreadId } from "./user-scoped-runner";

type AssistantSession = {
  user: {
    id: string;
  };
};

type AssistantThreadRecord = {
  id: string;
  title?: string | null;
  resourceId: string;
  createdAt: string | Date;
  updatedAt: string | Date;
  metadata?: unknown;
};

type AssistantThreadPage = {
  threads: AssistantThreadRecord[];
  total: number;
  page: number;
  perPage: number;
  hasMore: boolean;
};

type AssistantThreadEnv = {
  Variables: {
    assistantUserId: string;
  };
};

export type AssistantThreadMemory = {
  listThreads: (input: {
    filter: { resourceId: string };
    orderBy: { field: "updatedAt"; direction: "DESC" };
    page: number;
    perPage: number;
  }) => Promise<AssistantThreadPage>;
  getThreadById: (input: {
    threadId: string;
    resourceId?: string;
  }) => Promise<AssistantThreadRecord | null>;
  updateThread: (input: {
    id: string;
    title: string;
    metadata?: unknown;
  }) => Promise<AssistantThreadRecord>;
  deleteThread: (threadId: string) => Promise<void>;
};

export type AssistantThreadRouteDeps = {
  getSession: (headers: Headers) => Promise<AssistantSession | null>;
  getMemory: (
    requestContext: AssistantRequestContext,
  ) => Promise<AssistantThreadMemory | null>;
  deleteReplayHistory: (
    userId: string,
    threadId: string,
  ) => Promise<{ active: boolean; deletedRunCount: number }>;
};

const threadsQuerySchema = z.object({
  page: z.coerce.number().int().min(0).default(0),
  perPage: z.coerce.number().int().min(1).max(50).default(20),
});

const threadIdSchema = z.string().trim().min(1).max(128);

const updateThreadSchema = z.object({
  title: z
    .string()
    .max(512)
    .transform(normalizeAssistantThreadTitle)
    .pipe(z.string().min(1).max(64)),
});

function errorResponse(
  status: 400 | 401 | 404 | 409 | 500 | 503,
  code: string,
  message: string,
) {
  return Response.json({ error: { code, message } }, { status });
}

function isoDate(value: string | Date): string {
  return new Date(value).toISOString();
}

function sanitizeAssistantThread(thread: AssistantThreadRecord) {
  return {
    id: thread.id,
    title: thread.title?.trim() || null,
    createdAt: isoDate(thread.createdAt),
    updatedAt: isoDate(thread.updatedAt),
  };
}

const defaultDeps: AssistantThreadRouteDeps = {
  getSession: (headers) => auth.api.getSession({ headers }),
  getMemory: async (requestContext) => {
    const memory = await mastra
      .getAgent(ASSISTANT_AGENT_ID)
      .getMemory({ requestContext: requestContext as RequestContext });
    return memory as unknown as AssistantThreadMemory | null;
  },
  deleteReplayHistory: (userId, threadId) =>
    agUiAgentRunner.deleteThreadHistory(
      scopedAssistantThreadId(userId, threadId),
    ),
};

export function createAssistantThreadApp(
  deps: AssistantThreadRouteDeps = defaultDeps,
) {
  const app = new Hono<AssistantThreadEnv>();

  app.use("/api/assistant/*", async (c, next) => {
    let session: AssistantSession | null;
    try {
      session = await deps.getSession(c.req.raw.headers);
    } catch (error) {
      captureRequestError(error, { operation: "assistant_auth" });
      return errorResponse(503, "auth_unavailable", "Assistant access could not be verified.");
    }
    if (!session) {
      return errorResponse(401, "unauthorized", "Sign in to use assistant conversations.");
    }

    c.set("assistantUserId", session.user.id);
    return next();
  });

  app.get("/api/assistant/threads", async (c) => {
    const userId = c.get("assistantUserId");

    try {
      const input = threadsQuerySchema.parse({
        page: c.req.query("page"),
        perPage: c.req.query("perPage"),
      });
      const memory = await deps.getMemory(createUserRequestContext(userId));
      if (!memory) {
        return errorResponse(503, "memory_unavailable", "Assistant history is unavailable.");
      }

      const result = await memory.listThreads({
        filter: { resourceId: userId },
        orderBy: { field: "updatedAt", direction: "DESC" },
        page: input.page,
        perPage: input.perPage,
      });

      return c.json({
        threads: result.threads.map(sanitizeAssistantThread),
        total: result.total,
        page: result.page,
        perPage: result.perPage,
        hasMore: result.hasMore,
      });
    } catch (error) {
      if (error instanceof ZodError) {
        return errorResponse(400, "invalid_request", "Thread pagination is invalid.");
      }
      captureRequestError(error, { operation: "assistant_thread_list" });
      return errorResponse(500, "thread_list_failed", "Assistant history could not be loaded.");
    }
  });

  app.patch("/api/assistant/threads/:threadId", async (c) => {
    const userId = c.get("assistantUserId");

    try {
      const threadId = threadIdSchema.parse(c.req.param("threadId"));
      const body = await c.req.json().catch(() => ({}));
      const input = updateThreadSchema.parse(body);
      const memory = await deps.getMemory(createUserRequestContext(userId));
      if (!memory) {
        return errorResponse(503, "memory_unavailable", "Assistant history is unavailable.");
      }

      const current = await memory.getThreadById({
        threadId,
        resourceId: userId,
      });
      if (!current || current.resourceId !== userId) {
        return errorResponse(404, "thread_not_found", "Conversation not found.");
      }

      const updated = await memory.updateThread({
        id: threadId,
        title: input.title,
        metadata: current.metadata,
      });
      return c.json(sanitizeAssistantThread(updated));
    } catch (error) {
      if (error instanceof ZodError) {
        return errorResponse(400, "invalid_request", "Conversation title is invalid.");
      }
      captureRequestError(error, { operation: "assistant_thread_update" });
      return errorResponse(500, "thread_update_failed", "Conversation could not be updated.");
    }
  });

  app.delete("/api/assistant/threads/:threadId", async (c) => {
    const userId = c.get("assistantUserId");

    try {
      const threadId = threadIdSchema.parse(c.req.param("threadId"));
      const memory = await deps.getMemory(createUserRequestContext(userId));
      if (!memory) {
        return errorResponse(503, "memory_unavailable", "Assistant history is unavailable.");
      }

      const current = await memory.getThreadById({
        threadId,
        resourceId: userId,
      });
      if (current && current.resourceId !== userId) {
        return errorResponse(404, "thread_not_found", "Conversation not found.");
      }

      // Delete the derived AG-UI replay projection first. If Mastra deletion
      // then fails, a retry can still find and remove the canonical thread.
      const replay = await deps.deleteReplayHistory(userId, threadId);
      if (replay.active) {
        return errorResponse(
          409,
          "thread_running",
          "Wait for the current answer to finish before deleting this conversation.",
        );
      }
      if (!current && replay.deletedRunCount === 0) {
        return errorResponse(404, "thread_not_found", "Conversation not found.");
      }
      if (current) await memory.deleteThread(threadId);

      return c.body(null, 204);
    } catch (error) {
      if (error instanceof ZodError) {
        return errorResponse(400, "invalid_request", "Conversation ID is invalid.");
      }
      captureRequestError(error, { operation: "assistant_thread_delete" });
      return errorResponse(500, "thread_delete_failed", "Conversation could not be deleted.");
    }
  });

  return app;
}

export const assistantThreadApp = createAssistantThreadApp();
