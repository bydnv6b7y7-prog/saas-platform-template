import { NOTE_LIMITS, noteAttachments } from "@northwind/product/notes";
import { Button, buttonVariants } from "@northwind/ui/components/button";
import { Card, CardContent } from "@northwind/ui/components/card";
import { Input } from "@northwind/ui/components/input";
import { Label } from "@northwind/ui/components/label";
import { Skeleton } from "@northwind/ui/components/skeleton";
import { Textarea } from "@northwind/ui/components/textarea";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { Paperclip } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { captureAnalytics } from "@/lib/analytics";
import { formatUtcDateTime } from "@/lib/format";
import { AttachmentUploadError, uploadAttachment, uploadFailureMessage } from "@/product/notes/upload";
import { useTRPC, useTRPCClient } from "@/utils/trpc";

export const Route = createFileRoute("/_auth/(product)/notes")({
  head: () => ({ meta: [{ title: "My notes" }, { name: "robots", content: "noindex" }] }),
  component: NotesPage,
});

const ACCEPT = Object.keys(noteAttachments.types).join(",");
const formatBytes = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

function NotesPage() {
  const trpc = useTRPC();
  const notes = useQuery(trpc.notes.list.queryOptions());
  const usage = useQuery(trpc.notes.attachments.usage.queryOptions());

  return (
    <div className="page-shell max-w-3xl py-10">
      <header className="mb-8">
        <h1 className="text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">My notes</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          An example of the platform pieces working together: private data, files uploaded straight to object storage,
          a Free/Pro allowance, and an assistant that can read and propose notes.
        </p>
        {usage.data && (
          <p className="mt-3 text-sm" data-testid="attachment-usage">
            {usage.data.available
              ? `Attachments: ${usage.data.objects} of ${usage.data.limit.objects} on the ${usage.data.plan === "pro" ? "Pro" : "Free"} plan.`
              : "Attachments are off: this server has no object storage configured."}
            {usage.data.available && usage.data.plan === "free" && (
              <> <Link to="/pricing" className="font-medium underline underline-offset-4">Pro keeps {noteAttachments.quota.pro.objects}.</Link></>
            )}
          </p>
        )}
      </header>

      <NewNoteForm attachmentsAvailable={usage.data?.available ?? false} />

      <section aria-labelledby="notes-heading" className="mt-10">
        <h2 id="notes-heading" className="sr-only">Saved notes</h2>
        {notes.isPending ? (
          <div className="space-y-3" aria-busy="true" aria-label="Loading notes">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : notes.isError ? (
          <div role="alert" className="rounded-xl border border-destructive/40 p-4 text-sm">
            Your notes could not be loaded.{" "}
            <Button variant="link" className="h-auto p-0" onClick={() => notes.refetch()}>Try again</Button>
          </div>
        ) : notes.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">No notes yet. Write one above, or ask the assistant to draft one.</p>
        ) : (
          <ul className="space-y-3">
            {notes.data.map((note) => <NoteItem key={note.id} note={note} />)}
          </ul>
        )}
      </section>
    </div>
  );
}

function NewNoteForm({ attachmentsAvailable }: { attachmentsAvailable: boolean }) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState<"idle" | "uploading" | "saving">("idle");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const file = fileInput.current?.files?.[0] ?? null;
    let attachmentId: string | null = null;
    try {
      if (file) {
        setStage("uploading");
        attachmentId = await uploadAttachment(client, file);
      }
      setStage("saving");
      await client.notes.create.mutate({ title, body, attachmentId });
    } catch (failure) {
      setError(failure instanceof AttachmentUploadError
        ? uploadFailureMessage[failure.reason]
        : (failure as Error).message === "too_many_notes"
          ? `You can keep up to ${NOTE_LIMITS.perUser} notes.`
          : "The note could not be saved. Try again.");
      // The upload may have counted against the allowance even though the note failed.
      void queryClient.invalidateQueries({ queryKey: trpc.notes.attachments.usage.queryKey() });
      return;
    } finally {
      setStage("idle");
    }
    captureAnalytics("note_created", { source: "page", has_attachment: attachmentId !== null });
    setTitle("");
    setBody("");
    if (fileInput.current) fileInput.current.value = "";
    toast("Note saved");
    await queryClient.invalidateQueries({ queryKey: trpc.notes.pathKey() });
  };

  return (
    <Card>
      <CardContent>
        <form onSubmit={submit} className="space-y-4" aria-describedby={error ? "note-error" : undefined}>
          <div className="space-y-2">
            <Label htmlFor="note-title">Title</Label>
            <Input id="note-title" value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={NOTE_LIMITS.title} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="note-body">Note</Label>
            <Textarea id="note-body" value={body} onChange={(event) => setBody(event.target.value)} maxLength={NOTE_LIMITS.body} rows={4} />
          </div>
          {attachmentsAvailable && (
            <div className="space-y-2">
              <Label htmlFor="note-file">Attachment (PNG, JPEG or PDF, up to {noteAttachments.maxBytes / 1024 / 1024} MB)</Label>
              <Input id="note-file" type="file" accept={ACCEPT} ref={fileInput} />
            </div>
          )}
          {error && <p id="note-error" role="alert" className="text-sm text-destructive">{error}</p>}
          <Button type="submit" disabled={stage !== "idle"}>
            {stage === "uploading" ? "Uploading…" : stage === "saving" ? "Saving…" : "Save note"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

type Note = { id: string; title: string; body: string; createdAt: string | Date; attachment: { id: string; contentType: string; byteLength: number } | null };

function NoteItem({ note }: { note: Note }) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const remove = useMutation(trpc.notes.delete.mutationOptions({
    onSuccess: () => queryClient.invalidateQueries({ queryKey: trpc.notes.pathKey() }),
    onError: () => toast.error("The note could not be deleted. Try again."),
  }));

  const openAttachment = async () => {
    if (!note.attachment) return;
    // Open the tab first so the browser does not treat it as a pop-up once the link arrives.
    const tab = window.open("about:blank", "_blank");
    try {
      const { url } = await client.notes.attachments.viewUrl.query({ id: note.attachment.id });
      if (tab) tab.location.href = url;
      else window.location.href = url;
    } catch {
      tab?.close();
      toast.error("The attachment is no longer available.");
    }
  };

  return (
    <li className="rounded-xl border border-border bg-card p-4" data-testid="note">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="font-medium">{note.title}</h3>
          <p className="text-xs text-muted-foreground">{formatUtcDateTime(note.createdAt)}</p>
        </div>
        {confirming ? (
          <div className="flex shrink-0 gap-2">
            <Button size="sm" variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate({ id: note.id })}>
              {remove.isPending ? "Deleting…" : "Delete"}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setConfirming(false)}>Cancel</Button>
          </div>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setConfirming(true)} aria-label={`Delete ${note.title}`}>Delete…</Button>
        )}
      </div>
      {note.body && <p className="mt-2 whitespace-pre-wrap text-sm">{note.body}</p>}
      {note.attachment && (
        <button type="button" onClick={openAttachment} className={buttonVariants({ variant: "link", className: "mt-1 h-auto gap-1 p-0" })}>
          <Paperclip className="size-4" aria-hidden="true" />
          Open attachment ({note.attachment.contentType.split("/")[1]?.toUpperCase()}, {formatBytes(note.attachment.byteLength)})
        </button>
      )}
    </li>
  );
}
