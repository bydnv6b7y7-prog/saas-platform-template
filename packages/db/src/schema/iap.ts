import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { VerifiedSubscription } from "@northwind/better-auth-app-store/types";
import { user } from "./auth";

const time = (name: string) => timestamp(name, { withTimezone: true });

export const iapAccount = pgTable("iap_account", {
  id: uuid("id").primaryKey(),
  bundleId: text("bundle_id").notNull(),
  userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
  appAccountToken: uuid("app_account_token").notNull(),
  createdAt: time("created_at").defaultNow().notNull(),
}, t => [
  uniqueIndex("iap_account_user_uidx").on(t.bundleId, t.userId),
  uniqueIndex("iap_account_token_uidx").on(t.bundleId, t.appAccountToken),
]);

export const iapOwnershipAudit = pgTable("iap_ownership_audit", {
  id: uuid("id").primaryKey(),
  bundleId: text("bundle_id").notNull(),
  environment: text("environment").notNull(),
  originalTransactionId: text("original_transaction_id").notNull(),
  fromUserId: text("from_user_id"),
  toUserId: text("to_user_id").notNull(),
  ownershipVersion: integer("ownership_version").notNull(),
  expectedToken: uuid("expected_token"),
  targetToken: uuid("target_token").notNull(),
  operatorUserId: text("operator_user_id").notNull(),
  reason: text("reason").notNull(),
  createdAt: time("created_at").defaultNow().notNull(),
}, t => [
  uniqueIndex("iap_audit_version_uidx").on(t.bundleId, t.environment, t.originalTransactionId, t.ownershipVersion),
  index("iap_audit_chain_idx").on(t.bundleId, t.environment, t.originalTransactionId, t.createdAt),
  check("iap_audit_environment", sql`${t.environment} IN ('Production', 'Sandbox')`),
]);

export const iapSubscription = pgTable("iap_subscription", {
  id: uuid("id").primaryKey(),
  bundleId: text("bundle_id").notNull(),
  environment: text("environment").notNull(),
  originalTransactionId: text("original_transaction_id").notNull(),
  userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
  claimedAt: time("claimed_at"),
  ownershipVersion: integer("ownership_version").default(0).notNull(),
  // One shared, normalized projection; no raw JWS or user-submitted state here.
  snapshot: jsonb("snapshot").$type<VerifiedSubscription>(),
  lastVerifiedAt: time("last_verified_at"),
  verificationFailedAt: time("verification_failed_at"),
  lastError: text("last_error"),
  version: integer("version").default(0).notNull(),
  leaseOwner: uuid("lease_owner"),
  leaseExpiresAt: time("lease_expires_at"),
  nextReconcileAt: time("next_reconcile_at").defaultNow().notNull(),
  reconcileAttempts: integer("reconcile_attempts").default(0).notNull(),
  tokenSyncMode: text("token_sync_mode"),
  tokenSyncExpectedToken: uuid("token_sync_expected_token"),
  tokenSyncTargetToken: uuid("token_sync_target_token"),
  tokenSyncOwnershipVersion: integer("token_sync_ownership_version"),
  tokenSyncAuditId: uuid("token_sync_audit_id").references(() => iapOwnershipAudit.id),
  tokenSyncState: text("token_sync_state").default("none").notNull(),
  tokenSyncAttempts: integer("token_sync_attempts").default(0).notNull(),
  tokenSyncNextAttemptAt: time("token_sync_next_attempt_at"),
}, t => [
  uniqueIndex("iap_subscription_chain_uidx").on(t.bundleId, t.environment, t.originalTransactionId),
  index("iap_subscription_user_idx").on(t.bundleId, t.environment, t.userId),
  index("iap_subscription_reconcile_idx").on(t.nextReconcileAt),
  index("iap_subscription_token_pending_idx").on(t.tokenSyncNextAttemptAt).where(sql`${t.tokenSyncState} IN ('pending', 'writing', 'verify_pending')`),
  check("iap_subscription_environment", sql`${t.environment} IN ('Production', 'Sandbox')`),
  check("iap_subscription_claimed", sql`${t.userId} IS NULL OR ${t.claimedAt} IS NOT NULL`),
  check("iap_subscription_transfer_audit", sql`${t.tokenSyncMode} IS DISTINCT FROM 'transfer' OR ${t.tokenSyncAuditId} IS NOT NULL`),
]);

export const iapNotification = pgTable("iap_notification", {
  id: uuid("id").primaryKey(),
  bundleId: text("bundle_id").notNull(),
  environment: text("environment").notNull(),
  notificationUuid: uuid("notification_uuid").notNull(),
  type: text("type").notNull(),
  subtype: text("subtype"),
  signedPayload: text("signed_payload"),
  receivedAt: time("received_at").defaultNow().notNull(),
  processedAt: time("processed_at"),
  status: text("status").default("pending").notNull(),
  attempts: integer("attempts").default(0).notNull(),
  nextAttemptAt: time("next_attempt_at").defaultNow().notNull(),
  leaseOwner: uuid("lease_owner"),
  leaseExpiresAt: time("lease_expires_at"),
  errorCode: text("error_code"),
}, t => [
  uniqueIndex("iap_notification_uuid_uidx").on(t.bundleId, t.environment, t.notificationUuid),
  index("iap_notification_pending_idx").on(t.status, t.nextAttemptAt),
  check("iap_notification_environment", sql`${t.environment} IN ('Production', 'Sandbox')`),
]);

export const iapSyncState = pgTable("iap_sync_state", {
  bundleId: text("bundle_id").notNull(),
  environment: text("environment").notNull(),
  windowStart: time("window_start"),
  windowEnd: time("window_end"),
  paginationToken: text("pagination_token"),
  completedThrough: time("completed_through"),
  coverageGapAt: time("coverage_gap_at"),
  nextRunAt: time("next_run_at").defaultNow().notNull(),
  leaseOwner: uuid("lease_owner"),
  leaseExpiresAt: time("lease_expires_at"),
  appleNextRequestAt: time("apple_next_request_at").defaultNow().notNull(),
  appleBackoffUntil: time("apple_backoff_until"),
}, t => [
  uniqueIndex("iap_sync_state_scope_uidx").on(t.bundleId, t.environment),
  check("iap_sync_state_environment", sql`${t.environment} IN ('Production', 'Sandbox')`),
]);

/** Admin requests are durable before Apple is called. Never store JWS, tokens or raw errors. */
export const iapAdminAction = pgTable("iap_admin_action", {
  requestId: uuid("request_id").primaryKey(),
  bundleId: text("bundle_id").notNull(),
  environment: text("environment").notNull(),
  // Retain the operator identity after account deletion, like ownership audit records.
  actorId: text("actor_id").notNull(),
  status: text("status").default("pending").notNull(),
  errorCode: text("error_code"),
  createdAt: time("created_at").defaultNow().notNull(),
  updatedAt: time("updated_at").defaultNow().notNull(),
}, t => [
  index("iap_admin_action_scope_created_idx").on(t.bundleId, t.environment, t.createdAt),
  check("iap_admin_action_environment", sql`${t.environment} IN ('Production', 'Sandbox')`),
  check("iap_admin_action_status", sql`${t.status} IN ('pending', 'accepted', 'failed', 'unknown')`),
  check("iap_admin_action_error_code", sql`${t.errorCode} IS NULL OR ${t.errorCode} IN ('APPLE_REQUEST_REJECTED', 'APPLE_OUTCOME_UNKNOWN')`),
]);

export const iapTables = {
  account: iapAccount, subscription: iapSubscription, notification: iapNotification,
  syncState: iapSyncState, audit: iapOwnershipAudit,
};
