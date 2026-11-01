import { noteAttachments } from "@northwind/product/notes";

import type { useTRPCClient } from "@/utils/trpc";

export type UploadFailure = "type" | "size" | "quota" | "unavailable" | "network" | "rejected";

export class AttachmentUploadError extends Error {
  constructor(readonly reason: UploadFailure) {
    super(`Attachment upload failed: ${reason}`);
    this.name = "AttachmentUploadError";
  }
}

export const uploadFailureMessage: Record<UploadFailure, string> = {
  type: "Attach a PNG, JPEG or PDF.",
  size: `Files can be up to ${noteAttachments.maxBytes / 1024 / 1024} MB.`,
  quota: "Your plan's attachment allowance is used up. Delete a note with a file, or upgrade to Pro.",
  unavailable: "Attachments are switched off on this server.",
  network: "The file did not reach storage. Check your connection and try again.",
  rejected: "The uploaded file did not match what was announced. Try again.",
};

/**
 * Browser-direct upload (docs/object-storage.md): reserve a signed PUT, send the
 * bytes straight to the bucket, then have the server check them. Returns the
 * confirmed id to attach to a note.
 */
export async function uploadAttachment(client: ReturnType<typeof useTRPCClient>, file: File): Promise<string> {
  if (!Object.hasOwn(noteAttachments.types, file.type)) throw new AttachmentUploadError("type");
  if (file.size < 1 || file.size > noteAttachments.maxBytes) throw new AttachmentUploadError("size");
  let ticket: { id: string; url: string };
  try {
    ticket = await client.notes.attachments.reserve.mutate({ contentType: file.type, byteLength: file.size });
  } catch (error) {
    const reason = (error as Error).message;
    throw new AttachmentUploadError(reason === "quota" || reason === "type" || reason === "size" ? reason : "unavailable");
  }
  // The browser sets Content-Length from the file; the signature requires both to match the reservation.
  const response = await fetch(ticket.url, { method: "PUT", body: file, headers: { "Content-Type": file.type } }).catch(() => null);
  if (!response?.ok) throw new AttachmentUploadError("network");
  try {
    await client.notes.attachments.confirm.mutate({ id: ticket.id });
  } catch {
    throw new AttachmentUploadError("rejected");
  }
  return ticket.id;
}
