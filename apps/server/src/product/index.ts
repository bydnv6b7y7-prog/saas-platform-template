/**
 * Server product seam. Platform code (index.ts, mastra/) imports only this module from ./product;
 * a new product replaces the whole directory and keeps these exports.
 */
import {
  ASSISTANT_AGENT_ID,
  LIST_NOTES_TOOL,
  listNotesInputSchema,
  listNotesResultSchema,
  toListNotesResult,
} from "@northwind/product/assistant-contracts";
import { readNotes } from "@northwind/product/routers/notes";
import { Agent } from "@mastra/core/agent";
import { MASTRA_RESOURCE_ID_KEY } from "@mastra/core/request-context";
import { createTool } from "@mastra/core/tools";
import { Memory } from "@mastra/memory";

import { assistantModel } from "../mastra/model";
import { assistantRequestContextSchema } from "../mastra/request-context";
import { mastraStorage } from "../mastra/storage";

/** Example read-only tool: the signed-in user is the run's resource id, set by the server from the session. */
const listNotes = createTool({
  id: LIST_NOTES_TOOL.name,
  description: LIST_NOTES_TOOL.description,
  inputSchema: listNotesInputSchema,
  outputSchema: listNotesResultSchema,
  requestContextSchema: assistantRequestContextSchema,
  mcp: { annotations: { title: "My notes", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  execute: async (input, context) => {
    const userId = context.requestContext?.getRaw(MASTRA_RESOURCE_ID_KEY);
    if (typeof userId !== "string") throw new Error("listNotes needs a signed-in user");
    return toListNotesResult(await readNotes(userId, input.limit));
  },
});

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
Use listNotes to look at the user's notes; it shows titles and short excerpts only.
To save a note, call createNote with a title and body: the user confirms or declines it in the chat.
Never say a note was saved unless createNote returned ok: true.
`,
  tools: { listNotes },
});

/** Every agent this product registers with Mastra; must include ASSISTANT_AGENT_ID. */
export const assistantAgents = { [ASSISTANT_AGENT_ID]: assistant };

export const serverProduct = {
  serviceName: "api",
  /** Tables whose absence means product migrations have not been applied (/readyz). */
  readinessTables: ["note"] as string[],
  /** Extra fields on the GET / status document. */
  status: (): Record<string, string> => ({}),
  /** Prometheus text lines appended to /internal/metrics. */
  metrics: async (): Promise<string[]> => [],
  /** In-process background work started after the HTTP server listens; drained on shutdown. */
  startWorkers: (): { stopAndDrain: () => Promise<void> } | null => null,
};
