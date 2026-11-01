import {
  CREATE_NOTE_TOOL,
  LIST_NOTES_TOOL,
  createNoteInputSchema,
  createNoteResultSchema,
  listNotesInputSchema,
  listNotesResultSchema,
  type CreateNoteResult,
} from "@northwind/product/assistant-contracts";
import { Button } from "@northwind/ui/components/button";
import { useHumanInTheLoop, useRenderTool } from "@copilotkit/react-core/v2";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Paperclip } from "lucide-react";
import { useState } from "react";
import type { z } from "zod";

import { AGENT_ID } from "@/components/copilot/context";
import { captureAnalytics } from "@/lib/analytics";
import { useTRPC, useTRPCClient } from "@/utils/trpc";

function parsed<T extends z.ZodType>(schema: T, value: string): z.infer<T> | null {
  try {
    const result = schema.safeParse(JSON.parse(value));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

const Card = ({ children, label }: { children: React.ReactNode; label: string }) => (
  <section aria-label={label} className="my-2 rounded-xl border border-border bg-card p-3 text-sm">{children}</section>
);

/** Renders the read-only listNotes result as a card instead of raw JSON. */
export function NotesToolRenderers() {
  useRenderTool({
    name: LIST_NOTES_TOOL.name,
    agentId: AGENT_ID,
    parameters: listNotesInputSchema,
    render: ({ status, result }) => {
      if (status !== "complete") return <Card label="Notes">Reading your notes…</Card>;
      const notes = parsed(listNotesResultSchema, result);
      if (!notes) return <Card label="Notes">The notes could not be displayed.</Card>;
      return (
        <Card label="Your notes">
          {notes.notes.length === 0 ? <p>No notes yet.</p> : (
            <ul className="space-y-1.5">
              {notes.notes.map((note) => (
                <li key={note.id}>
                  <span className="font-medium">{note.title}</span>
                  {note.hasAttachment && <Paperclip className="ml-1 inline size-3.5" aria-label="has an attachment" />}
                  {note.excerpt && <span className="block truncate text-muted-foreground">{note.excerpt}</span>}
                </li>
              ))}
            </ul>
          )}
          <Link to="/notes" className="mt-2 inline-block font-medium underline underline-offset-4">Open My notes</Link>
        </Card>
      );
    },
  }, []);
  return null;
}

/**
 * createNote runs in the browser and saves nothing until the user presses Save.
 * Its result is page state (ASSISTANT_PAGE_TOOL_NAMES): a replayed thread shows
 * the outcome but never asks again or saves twice.
 */
export function NotesPageTools() {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const queryClient = useQueryClient();

  useHumanInTheLoop({
    name: CREATE_NOTE_TOOL.name,
    description: CREATE_NOTE_TOOL.description,
    agentId: AGENT_ID,
    parameters: createNoteInputSchema,
    render: (props) => {
      if (props.status === "inProgress") return <Card label="Draft note">Drafting a note…</Card>;
      if (props.status === "complete") {
        const outcome = parsed(createNoteResultSchema, props.result);
        return (
          <Card label="Draft note">
            <span className="font-medium">{props.args.title}</span>
            {" — "}
            {outcome?.ok ? <>saved to <Link to="/notes" className="font-medium underline underline-offset-4">My notes</Link>.</> : "not saved."}
          </Card>
        );
      }
      return <ConfirmNote draft={props.args} onDone={async (outcome) => {
        await props.respond(outcome);
        if (outcome.ok) {
          captureAnalytics("note_created", { source: "assistant", has_attachment: false });
          await queryClient.invalidateQueries({ queryKey: trpc.notes.pathKey() });
        }
      }} save={(draft) => client.notes.create.mutate({ ...draft, attachmentId: null })} />;
    },
  }, [client, queryClient, trpc]);

  return null;
}

function ConfirmNote({ draft, save, onDone }: {
  draft: z.infer<typeof createNoteInputSchema>;
  save: (draft: z.infer<typeof createNoteInputSchema>) => Promise<{ id: string }>;
  onDone: (outcome: CreateNoteResult) => Promise<void>;
}) {
  const [state, setState] = useState<"ask" | "saving" | "failed">("ask");
  const confirm = async () => {
    setState("saving");
    try {
      const { id } = await save(draft);
      await onDone({ ok: true, id });
    } catch {
      setState("failed");
    }
  };
  return (
    <Card label="Draft note">
      <p className="font-medium">{draft.title}</p>
      {draft.body && <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{draft.body}</p>}
      {state === "failed" && <p role="alert" className="mt-2 text-destructive">The note could not be saved. Try again or discard it.</p>}
      <div className="mt-3 flex gap-2">
        <Button size="sm" onClick={confirm} disabled={state === "saving"}>{state === "saving" ? "Saving…" : "Save note"}</Button>
        <Button size="sm" variant="outline" disabled={state === "saving"} onClick={() => onDone({ ok: false, code: "declined" })}>Discard</Button>
      </div>
    </Card>
  );
}
