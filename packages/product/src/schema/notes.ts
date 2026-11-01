import { user } from "@northwind/db/schema/auth";
import { storedObject } from "@northwind/db/schema/stored-object";
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Example: a signed-in user's notes, each with at most one attachment in object
 * storage. Deleting the account deletes the notes; their attachments are
 * orphaned in stored_object and removed by the hourly clean-up.
 */
export const note = pgTable("note", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  attachmentId: uuid("attachment_id").unique().references(() => storedObject.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("note_user_created_idx").on(t.userId, t.createdAt)]);
