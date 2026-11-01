import { sql } from "drizzle-orm";
import { check, doublePrecision, index, integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

/** Pseudonymous rate/cost buckets shared by the assistant quota and product features. */
export const usageBuckets = pgTable(
  "usage_buckets",
  {
    subjectHash: text("subject_hash").notNull(),
    action: text("action").notNull(),
    windowSeconds: integer("window_seconds").notNull(),
    bucketStartedAt: timestamp("bucket_started_at", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0),
    costUnits: doublePrecision("cost_units").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.subjectHash, t.action, t.windowSeconds, t.bucketStartedAt] }),
    index("usage_buckets_expiry_idx").on(t.expiresAt),
    check(
      "usage_buckets_values_check",
      sql`${t.windowSeconds} > 0 AND ${t.count} >= 0 AND ${t.costUnits} >= 0`,
    ),
  ],
);
