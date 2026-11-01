import { z } from "zod";

import { NOTE_LIMITS } from "./notes";

/** The product's primary assistant; the platform copilot runtime, thread API and web sidecar all address it. */
export const ASSISTANT_AGENT_ID = "assistant";

/** Frontend-executed tools: their results are transient page state, never persisted as run history. */
export const ASSISTANT_PAGE_TOOL_NAMES = ["createNote"] as const satisfies readonly string[];

/** Page state the web sidecar shares with the assistant on every run. */
export const assistantPageContextSchema = z.object({
  kind: z.literal("page"),
  path: z.string().max(300),
});
export type AssistantPageContext = z.infer<typeof assistantPageContextSchema>;

// Example tools (My notes). The server tool and the web renderer both use these schemas,
// so a change to one side that the other cannot read fails assistant-contracts.test.ts.

/** Server tool, read-only: the signed-in user's latest notes. */
export const LIST_NOTES_TOOL = {
  name: "listNotes",
  description: "List the signed-in user's most recent notes (title, a short excerpt, whether a file is attached). Read-only.",
} as const;
export const listNotesInputSchema = z.object({ limit: z.number().int().min(1).max(20).default(5) });
export const listNotesResultSchema = z.object({
  notes: z.array(z.object({
    id: z.uuid(),
    title: z.string(),
    excerpt: z.string().max(160),
    createdAt: z.iso.datetime(),
    hasAttachment: z.boolean(),
  })),
});
export type ListNotesResult = z.infer<typeof listNotesResultSchema>;

/** Shapes stored notes into the tool result; excerpts keep note bodies out of the model's context. */
export function toListNotesResult(rows: { id: string; title: string; body: string; createdAt: Date; attachment: unknown }[]): ListNotesResult {
  return listNotesResultSchema.parse({
    notes: rows.map((row) => ({
      id: row.id,
      title: row.title,
      excerpt: row.body.replace(/\s+/g, " ").trim().slice(0, 160),
      createdAt: row.createdAt.toISOString(),
      hasAttachment: row.attachment !== null,
    })),
  });
}

/** Frontend tool: drafts a note the user must confirm in the chat before it is saved. */
export const CREATE_NOTE_TOOL = {
  name: "createNote",
  description: "Propose a new note for the user. The user sees the draft and decides whether to save it; nothing is saved without their confirmation.",
} as const;
export const createNoteInputSchema = z.object({
  title: z.string().trim().min(1).max(NOTE_LIMITS.title),
  body: z.string().trim().max(NOTE_LIMITS.body),
});
export const createNoteResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), id: z.uuid() }),
  z.object({ ok: z.literal(false), code: z.enum(["declined", "failed"]) }),
]);
export type CreateNoteResult = z.infer<typeof createNoteResultSchema>;
