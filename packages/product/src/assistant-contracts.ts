import { z } from "zod";

/** The product's primary assistant; the platform copilot runtime, thread API and web sidecar all address it. */
export const ASSISTANT_AGENT_ID = "assistant";

/** Frontend-executed tools: their results are transient page state, never persisted as run history. */
export const ASSISTANT_PAGE_TOOL_NAMES = [] as const satisfies readonly string[];

/** Page state the web sidecar shares with the assistant on every run. */
export const assistantPageContextSchema = z.object({
  kind: z.literal("page"),
  path: z.string().max(300),
});
export type AssistantPageContext = z.infer<typeof assistantPageContextSchema>;
