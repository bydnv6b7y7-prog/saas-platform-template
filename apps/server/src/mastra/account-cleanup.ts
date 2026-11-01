import { registerAccountDeletionHooks } from "@northwind/auth/account-deletion";
import { pool } from "@northwind/db";
import type { RequestContext } from "@mastra/core/request-context";

import { logError, logInfo } from "../logging";
import { agUiAgentRunner } from "./agent-runner";
import { ASSISTANT_AGENT_ID } from "@northwind/product/assistant-contracts";
import { mastra } from "./index";
import { createUserRequestContext } from "./request-context";
import { scopedAssistantThreadId } from "./user-scoped-runner";

// Agent memory exposes thread listing/deletion (see thread-routes.ts), but
// observational-memory cleanup lives on the storage memory domain.
type AssistantHistoryMemory = {
  listThreads: (input: {
    filter: { resourceId: string };
    orderBy: { field: "updatedAt"; direction: "DESC" };
    page: number;
    perPage: number | false;
  }) => Promise<{ threads: { id: string }[] }>;
  deleteThread: (threadId: string) => Promise<void>;
};

type ObservationalMemoryStore = {
  clearObservationalMemory: (
    threadId: string | null,
    resourceId: string,
  ) => Promise<void>;
};

async function getUserMemory(userId: string): Promise<AssistantHistoryMemory> {
  const memory = await mastra
    .getAgent(ASSISTANT_AGENT_ID)
    .getMemory({ requestContext: createUserRequestContext(userId) as RequestContext });
  return memory as unknown as AssistantHistoryMemory;
}

function observationalMemoryStore(memory: AssistantHistoryMemory): ObservationalMemoryStore | null {
  const storage = (memory as unknown as {
    _storage?: { stores?: { memory?: ObservationalMemoryStore } };
  })._storage;
  return storage?.stores?.memory ?? null;
}

/**
 * Removes every assistant conversation belonging to a deleted account:
 * AG-UI replay projections, Mastra threads/messages/vectors, observational
 * memory, plus the residual rows deleteThread leaves behind (thread state
 * keyed by quoted camelCase "threadId"; resource-scoped working memory).
 * Failures propagate so the shared account-deletion routine can log them
 * without blocking the account delete.
 */
async function deleteAssistantHistory(userId: string): Promise<void> {
  const memory = await getUserMemory(userId);
  const { threads } = await memory.listThreads({
    filter: { resourceId: userId },
    orderBy: { field: "updatedAt", direction: "DESC" },
    page: 0,
    perPage: false,
  });

  const observationalMemory = observationalMemoryStore(memory);
  const failures: string[] = [];
  for (const thread of threads) {
    try {
      await agUiAgentRunner.deleteThreadHistory(
        scopedAssistantThreadId(userId, thread.id),
      );
      await memory.deleteThread(thread.id);
      if (observationalMemory) {
        await observationalMemory.clearObservationalMemory(thread.id, userId);
      }
    } catch (error) {
      failures.push(thread.id);
      logError("assistant_account_cleanup_thread_failed", error, {
        threadId: thread.id,
      });
    }
  }

  try {
    if (observationalMemory) {
      await observationalMemory.clearObservationalMemory(null, userId);
    }
  } catch (error) {
    logError("assistant_account_cleanup_resource_memory_failed", error);
  }

  if (threads.length > 0) {
    await pool.query(
      `DELETE FROM mastra.mastra_thread_state WHERE "threadId" = ANY($1::text[])`,
      [threads.map((thread) => thread.id)],
    );
  }
  // Resource-scoped working memory has no delete API in this Mastra version.
  await pool.query(`DELETE FROM mastra.mastra_resources WHERE id = $1`, [userId]);

  if (failures.length > 0) {
    throw new Error(
      `${failures.length} assistant conversation(s) could not be fully deleted`,
    );
  }

  logInfo("assistant_account_cleanup_completed", {
    threadCount: threads.length,
  });
}

export function registerAssistantAccountCleanup(): void {
  registerAccountDeletionHooks({ deleteConversationHistory: deleteAssistantHistory });
}
