import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { user } from "./auth";

const time = (name: string) => timestamp(name, { withTimezone: true });

/**
 * One row per object a signed-in user may upload (docs/object-storage.md). The
 * row is written before anything is signed, so every object that can exist in
 * the bucket has a row that will delete it. Deleting the account clears
 * `user_id`; the hourly clean-up then deletes the object and the row.
 */
export const storedObject = pgTable("stored_object", {
  id: uuid("id").primaryKey(),
  purpose: text("purpose").notNull(),
  userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
  objectKey: text("object_key").notNull().unique(),
  contentType: text("content_type").notNull(),
  byteLength: integer("byte_length").notNull(),
  createdAt: time("created_at").notNull().defaultNow(),
  /** Set once the service has checked the uploaded bytes. */
  confirmedAt: time("confirmed_at"),
  /** Set when the owner no longer needs it; the clean-up deletes it. */
  releasedAt: time("released_at"),
}, (t) => [
  index("stored_object_user_purpose_idx").on(t.userId, t.purpose),
  index("stored_object_created_idx").on(t.createdAt),
  check("stored_object_size_check", sql`${t.byteLength} > 0`),
]);
