import { FEEDBACK_CONTEXTS, type AppClientConfig } from "@northwind/env/app-client-config";
import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { user } from "./auth";

const time = (name: string) => timestamp(name, { withTimezone: true });

/** The native app's remote settings: one complete snapshot; shared defaults apply until the first save. */
export const appClientConfig = pgTable("app_client_config", {
  id: integer("id").primaryKey().default(1),
  values: jsonb("values").$type<AppClientConfig>().notNull(),
  revision: integer("revision").notNull(),
  updatedAt: time("updated_at").notNull().defaultNow(),
  // Keep the historical actor even if the auth account is later removed.
  updatedBy: text("updated_by").notNull(),
}, (t) => [
  check("app_client_config_singleton_check", sql`${t.id} = 1`),
  check("app_client_config_revision_check", sql`${t.revision} >= 1`),
  check("app_client_config_values_check", sql`jsonb_typeof(${t.values}) = 'object'`),
]);

export const appClientConfigAudit = pgTable("app_client_config_audit", {
  revision: integer("revision").primaryKey(),
  actorId: text("actor_id").notNull(),
  createdAt: time("created_at").notNull().defaultNow(),
  before: jsonb("before").$type<AppClientConfig>().notNull(),
  after: jsonb("after").$type<AppClientConfig>().notNull(),
}, (t) => [
  check("app_client_config_audit_revision_check", sql`${t.revision} >= 1`),
]);

export type AppFeedbackDiagnostics = {
  appVersion?: string;
  build?: string;
  os?: string;
  device?: string;
  locale?: string;
  widgetFamilies?: string[];
  pro?: boolean;
  theme?: string;
};

/** One piece of feedback from the app. The words never change after creation; only its handling does. */
export const appFeedback = pgTable("app_feedback", {
  id: uuid("id").primaryKey(),
  installationId: uuid("installation_id").notNull(),
  // From the session only, never from the request body. Deleting the account
  // deletes its feedback too: the words are the reader's own content.
  userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
  // sha256(ip + secret): enough to rate-limit, never the address itself.
  ipHash: text("ip_hash").notNull(),
  category: text("category").notNull(),
  message: text("message").notNull(),
  contact: text("contact"),
  context: text("context"),
  diagnostics: jsonb("diagnostics").$type<AppFeedbackDiagnostics>().notNull(),
  hasScreenshot: boolean("has_screenshot").notNull().default(false),
  status: text("status").notNull().default("new"),
  handledBy: text("handled_by"),
  handledAt: time("handled_at"),
  createdAt: time("created_at").notNull().defaultNow(),
}, (t) => [
  index("app_feedback_created_idx").on(t.createdAt),
  index("app_feedback_status_created_idx").on(t.status, t.createdAt),
  index("app_feedback_installation_created_idx").on(t.installationId, t.createdAt),
  index("app_feedback_ip_created_idx").on(t.ipHash, t.createdAt),
  check("app_feedback_status_check", sql`${t.status} IN ('new', 'done')`),
  check("app_feedback_category_check", sql`${t.category} IN ('bug', 'suggestion', 'other')`),
  check("app_feedback_context_check", sql`${t.context} IS NULL OR ${t.context} IN (${sql.raw(FEEDBACK_CONTEXTS.map((context) => `'${context}'`).join(", "))})`),
]);

/**
 * The ledger of screenshot objects in R2, one row per upload the service signed
 * (docs/app-feedback-rating.md). An object is only ever deleted through its row:
 * unclaimed uploads after a day, claimed ones after retention, and ones whose
 * feedback was deleted (the reference is set to null) at the next clean-up.
 */
export const appFeedbackScreenshot = pgTable("app_feedback_screenshot", {
  // The upload id the app is given; also the random part of the object key.
  id: uuid("id").primaryKey(),
  objectKey: text("object_key").notNull().unique(),
  installationId: uuid("installation_id").notNull(),
  ipHash: text("ip_hash").notNull(),
  byteLength: integer("byte_length").notNull(),
  createdAt: time("created_at").notNull().defaultNow(),
  feedbackId: uuid("feedback_id").unique().references(() => appFeedback.id, { onDelete: "set null" }),
  attachedAt: time("attached_at"),
}, (t) => [
  index("app_feedback_screenshot_installation_created_idx").on(t.installationId, t.createdAt),
  index("app_feedback_screenshot_ip_created_idx").on(t.ipHash, t.createdAt),
  index("app_feedback_screenshot_created_idx").on(t.createdAt),
  check("app_feedback_screenshot_size_check", sql`${t.byteLength} BETWEEN 1 AND 1000000`),
  check("app_feedback_screenshot_attached_check", sql`${t.feedbackId} IS NULL OR ${t.attachedAt} IS NOT NULL`),
]);
