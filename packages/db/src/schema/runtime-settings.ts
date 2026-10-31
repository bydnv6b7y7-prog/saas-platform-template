import { sql } from "drizzle-orm";
import { check, integer, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Admin-editable runtime settings, one complete snapshot per scope. The platform owns the
 * "operations" scope; products register their own scopes (see packages/api/src/settings-store.ts).
 * Deployment values apply to a scope until its first save.
 */
export const runtimeSettings = pgTable("runtime_settings", {
  scope: text("scope").primaryKey(),
  values: jsonb("values").$type<Record<string, unknown>>().notNull(),
  revision: integer("revision").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  // Keep the historical actor even if the auth account is later removed.
  updatedBy: text("updated_by").notNull(),
}, (table) => [
  check("runtime_settings_revision_check", sql`${table.revision} >= 1`),
  check("runtime_settings_values_check", sql`jsonb_typeof(${table.values}) = 'object'`),
]);

export const runtimeSettingsAudit = pgTable("runtime_settings_audit", {
  scope: text("scope").notNull(),
  revision: integer("revision").notNull(),
  actorId: text("actor_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  before: jsonb("before").$type<Record<string, unknown>>().notNull(),
  after: jsonb("after").$type<Record<string, unknown>>().notNull(),
}, (table) => [
  primaryKey({ columns: [table.scope, table.revision] }),
  check("runtime_settings_audit_revision_check", sql`${table.revision} >= 1`),
  check("runtime_settings_audit_before_check", sql`jsonb_typeof(${table.before}) = 'object'`),
  check("runtime_settings_audit_after_check", sql`jsonb_typeof(${table.after}) = 'object'`),
]);
