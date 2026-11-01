import { adminProcedure, protectedProcedure, router } from "@northwind/api";
import { createUploadRouter } from "@northwind/api/routers/uploads";
import { userObjects } from "@northwind/api/user-objects";
import { and, db, desc, eq, sql } from "@northwind/db";
import { storedObject } from "@northwind/db/schema/stored-object";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { NOTE_LIMITS, newNoteSchema, noteAttachments } from "../notes";
import { note } from "../schema/notes";

/** The user's notes, newest first; shared by the page and the assistant's read-only tool. */
export async function readNotes(userId: string, limit: number = NOTE_LIMITS.perUser) {
  return db.select({
    id: note.id,
    title: note.title,
    body: note.body,
    createdAt: note.createdAt,
    attachment: sql<{ id: string; contentType: string; byteLength: number } | null>`case when ${storedObject.id} is null then null
      else json_build_object('id', ${storedObject.id}, 'contentType', ${storedObject.contentType}, 'byteLength', ${storedObject.byteLength}) end`,
  }).from(note)
    .leftJoin(storedObject, eq(storedObject.id, note.attachmentId))
    .where(eq(note.userId, userId))
    .orderBy(desc(note.createdAt))
    .limit(limit);
}

export const notesRouter = router({
  list: protectedProcedure.query(({ ctx }) => readNotes(ctx.session.user.id)),

  create: protectedProcedure.input(newNoteSchema).mutation(async ({ ctx, input }) => {
    const userId = ctx.session.user.id;
    // confirm() is idempotent and checks owner, purpose and bytes: only a real upload of this user's can be attached.
    if (input.attachmentId && !await userObjects.confirm(userId, noteAttachments, input.attachmentId)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "attachment_unavailable" });
    }
    const [counted] = await db.select({ total: sql<number>`count(*)::int` }).from(note).where(eq(note.userId, userId));
    if ((counted?.total ?? 0) >= NOTE_LIMITS.perUser) throw new TRPCError({ code: "FORBIDDEN", message: "too_many_notes" });
    try {
      const [created] = await db.insert(note).values({ userId, ...input }).returning({ id: note.id });
      return created!;
    } catch (error) {
      // The unique attachment_id: one upload belongs to one note.
      if ((error as { cause?: { code?: string } }).cause?.code === "23505") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "attachment_unavailable" });
      }
      throw error;
    }
  }),

  delete: protectedProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    const deleted = await db.transaction(async (transaction) => {
      const [row] = await transaction.delete(note)
        .where(and(eq(note.id, input.id), eq(note.userId, ctx.session.user.id)))
        .returning({ attachmentId: note.attachmentId });
      // Released in the same transaction: the attachment is deleted from storage at the next clean-up.
      if (row?.attachmentId) await userObjects.release([row.attachmentId], transaction);
      return row !== undefined;
    });
    if (!deleted) throw new TRPCError({ code: "NOT_FOUND" });
    return { ok: true };
  }),

  attachments: createUploadRouter(noteAttachments),

  /** Admin → Notes: totals only, never note contents. */
  adminStats: adminProcedure.query(async () => {
    const [notes] = await db.select({
      notes: sql<number>`count(*)::int`,
      authors: sql<number>`count(distinct ${note.userId})::int`,
    }).from(note);
    const [files] = await db.select({
      attachments: sql<number>`count(*)::int`,
      bytes: sql<number>`coalesce(sum(${storedObject.byteLength}), 0)::float8`,
      pending: sql<number>`count(*) filter (where ${storedObject.confirmedAt} is null)::int`,
    }).from(storedObject).where(and(eq(storedObject.purpose, noteAttachments.name), sql`${storedObject.releasedAt} is null`));
    return { ...notes!, ...files! };
  }),
});
