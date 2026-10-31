import { createHash } from "node:crypto";

import { rawQuery } from "@northwind/db";

type UsageAction =
  | "semantic_query"
  | "investigation"
  | "evidence_fetch"
  | "assistant_run";

type UsageInput = {
  subjectHash: string;
  action: UsageAction;
  countLimit: number;
  costLimit: number;
  costUnits: number;
  now?: number;
  windowMs: number;
};

export type UsageReservation = {
  subjectHash: string;
  action: UsageAction;
  windowSeconds: number;
  bucketStartedAt: Date;
  costUnits: number;
};

export type UsageSnapshot = {
  used: number;
  remaining: number;
  resetAt: Date;
};

export function usageWindow(windowMs: number, now = Date.now()) {
  const bucketStartedAt = new Date(Math.floor(now / windowMs) * windowMs);
  return {
    bucketStartedAt,
    resetAt: new Date(bucketStartedAt.getTime() + windowMs),
    windowSeconds: Math.floor(windowMs / 1_000),
  };
}

export async function reserveUsage(input: UsageInput): Promise<UsageReservation | null> {
  const window = usageWindow(input.windowMs, input.now);
  const expiresAt = new Date(window.bucketStartedAt.getTime() + input.windowMs * 2);
  const result = await rawQuery<{ count: number }>(
    `INSERT INTO usage_buckets
       (subject_hash, action, window_seconds, bucket_started_at, count, cost_units, expires_at)
     SELECT $1::text, $2::text, $3::int, $4::timestamptz,
            1, $5::double precision, $6::timestamptz
     WHERE 1 <= $7::int AND $5::double precision <= $8::double precision
     ON CONFLICT (subject_hash, action, window_seconds, bucket_started_at)
     DO UPDATE SET
       count = usage_buckets.count + 1,
       cost_units = usage_buckets.cost_units + EXCLUDED.cost_units,
       expires_at = EXCLUDED.expires_at
     WHERE usage_buckets.count + 1 <= $7
       AND usage_buckets.cost_units + EXCLUDED.cost_units <= $8
     RETURNING count`,
    [
      input.subjectHash,
      input.action,
      window.windowSeconds,
      window.bucketStartedAt,
      input.costUnits,
      expiresAt,
      input.countLimit,
      input.costLimit,
    ],
  );
  if (result.rows.length !== 1) return null;
  return {
    subjectHash: input.subjectHash,
    action: input.action,
    windowSeconds: window.windowSeconds,
    bucketStartedAt: window.bucketStartedAt,
    costUnits: input.costUnits,
  };
}

export async function consumeUsage(input: UsageInput): Promise<boolean> {
  return (await reserveUsage(input)) !== null;
}

export async function releaseUsage(reservation: UsageReservation): Promise<void> {
  await rawQuery(
    `UPDATE usage_buckets
        SET count = GREATEST(count - 1, 0),
            cost_units = GREATEST(cost_units - $5::double precision, 0)
      WHERE subject_hash = $1
        AND action = $2
        AND window_seconds = $3
        AND bucket_started_at = $4::timestamptz
        AND count > 0`,
    [
      reservation.subjectHash,
      reservation.action,
      reservation.windowSeconds,
      reservation.bucketStartedAt,
      reservation.costUnits,
    ],
  );
}

export async function readUsage(input: {
  subjectHash: string;
  action: UsageAction;
  countLimit: number;
  windowMs: number;
}): Promise<UsageSnapshot> {
  const window = usageWindow(input.windowMs);
  const result = await rawQuery<{ count: number }>(
    `SELECT count
       FROM usage_buckets
      WHERE subject_hash = $1
        AND action = $2
        AND window_seconds = $3
        AND bucket_started_at = $4::timestamptz`,
    [
      input.subjectHash,
      input.action,
      window.windowSeconds,
      window.bucketStartedAt,
    ],
  );
  const used = result.rows[0]?.count ?? 0;
  return {
    used,
    remaining: Math.max(0, input.countLimit - used),
    resetAt: window.resetAt,
  };
}

export function privacyHash(value: string, secret: string): string {
  return createHash("sha256").update(`${secret}:${value}`).digest("hex");
}
