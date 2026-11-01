import type { UserStoragePurpose } from "@northwind/api/user-objects";
import { z } from "zod";

/**
 * Example contract shared by the notes router, the assistant and the web page.
 * Plain data only: the browser imports this file.
 */
export const noteAttachments = {
  name: "note-attachment",
  types: {
    "image/png": { extension: "png", magic: [0x89, 0x50, 0x4e, 0x47] },
    "image/jpeg": { extension: "jpg", magic: [0xff, 0xd8, 0xff] },
    "application/pdf": { extension: "pdf", magic: [0x25, 0x50, 0x44, 0x46] },
  },
  maxBytes: 5 * 1024 * 1024,
  uploadSeconds: 600,
  viewSeconds: 600,
  quota: {
    free: { objects: 3, bytes: 10 * 1024 * 1024 },
    pro: { objects: 100, bytes: 500 * 1024 * 1024 },
  },
} satisfies UserStoragePurpose;

export const NOTE_LIMITS = { title: 120, body: 5_000, perUser: 200 } as const;

export const newNoteSchema = z.strictObject({
  title: z.string().trim().min(1).max(NOTE_LIMITS.title),
  body: z.string().trim().max(NOTE_LIMITS.body),
  /** A confirmed upload from `notes.attachments`; `null` for none. */
  attachmentId: z.uuid().nullable(),
});
export type NewNote = z.infer<typeof newNoteSchema>;
