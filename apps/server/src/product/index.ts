/**
 * Server product seam. Platform code (index.ts, mastra/) imports only this module from ./product;
 * a new product replaces the whole directory and keeps these exports.
 */
import { ASSISTANT_AGENT_ID } from "@northwind/product/assistant-contracts";
import { Agent } from "@mastra/core/agent";
import { Memory } from "@mastra/memory";

import { assistantModel } from "../mastra/model";
import { assistantRequestContextSchema } from "../mastra/request-context";
import { mastraStorage } from "../mastra/storage";

const assistant = new Agent({
  id: ASSISTANT_AGENT_ID,
  name: "Assistant",
  model: assistantModel,
  requestContextSchema: assistantRequestContextSchema,
  defaultOptions: { maxSteps: 4 },
  // Memory is required: the platform thread API and account deletion read and erase it.
  memory: new Memory({ storage: mastraStorage, options: { lastMessages: 16, semanticRecall: false } }),
  instructions: `
You are the in-app assistant. Answer concisely and honestly.
The user message may include the current page as JSON context; use it only to orient your answer.
Never claim to have performed actions you have no tool for.
`,
  // tools: { ... } — add read-only product tools here (see @mastra/core createTool).
});

/** Every agent this product registers with Mastra; must include ASSISTANT_AGENT_ID. */
export const assistantAgents = { [ASSISTANT_AGENT_ID]: assistant };

export const serverProduct = {
  serviceName: "api",
  /** Tables whose absence means product migrations have not been applied (/readyz). */
  readinessTables: [] as string[],
  /** Extra fields on the GET / status document. */
  status: (): Record<string, string> => ({}),
  /** Prometheus text lines appended to /internal/metrics. */
  metrics: async (): Promise<string[]> => [],
  /** In-process background work started after the HTTP server listens; drained on shutdown. */
  startWorkers: (): { stopAndDrain: () => Promise<void> } | null => null,
};
