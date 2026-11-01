import { AppStoreError } from "./errors";
import type { AppStoreEnvironment, AppStoreStatus, SubscriptionRecord, TokenJob, VerifiedSubscription, VerifiedTransaction } from "./types";

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const DEFAULT_RECONCILE_INTERVAL = 6 * HOUR;
export const DEFAULT_REVERIFY_INTERVAL = 15 * 60_000;
export const LEASE_MS = 180_000;

export function normalizeToken(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new AppStoreError("INVALID_SIGNED_DATA");
  }
  return value.toLowerCase();
}
export function transactionId(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,39}$/.test(value)) throw new AppStoreError("INVALID_SIGNED_DATA");
  return value;
}
export function environment(value: unknown, allowed: readonly AppStoreEnvironment[]): AppStoreEnvironment {
  if ((value !== "Production" && value !== "Sandbox") || !allowed.includes(value)) throw new AppStoreError("INVALID_ENVIRONMENT");
  return value;
}
export function validUntil(snapshot: VerifiedSubscription | null, now: number): number | null {
  if (!snapshot || snapshot.revokedAt !== null || snapshot.isUpgraded) return null;
  const end = snapshot.status === 1 ? snapshot.expiresAt : snapshot.status === 4 ? snapshot.graceExpiresAt : null;
  return end !== null && end > now ? end : null;
}
export function nextReconcileAt(snapshot: VerifiedSubscription | null, now: number, interval = DEFAULT_RECONCILE_INTERVAL): Date {
  if (!Number.isFinite(interval) || interval <= 0) throw new Error("Reconcile interval must be positive");
  const boundary = snapshot?.status === 1 ? snapshot.expiresAt : snapshot?.status === 4 ? snapshot.graceExpiresAt : null;
  const check = boundary === null ? null : boundary + HOUR;
  return new Date(check !== null && check > now ? Math.min(now + interval, check) : now + interval);
}
export function retryAt(attempts: number, now: number): Date {
  return new Date(now + Math.min(6 * HOUR, 60_000 * 2 ** Math.min(attempts, 12)));
}
function isStale(row: SubscriptionRecord, now: number, interval = DEFAULT_RECONCILE_INTERVAL): boolean {
  return !row.lastVerifiedAt || row.verificationFailedAt !== null || now - row.lastVerifiedAt.getTime() > interval * 2;
}
export function statusFor(rows: SubscriptionRecord[], env: AppStoreEnvironment, now: number, interval = DEFAULT_RECONCILE_INTERVAL): AppStoreStatus {
  const groups = new Map<string, SubscriptionRecord[]>();
  for (const row of rows) {
    if (row.environment !== env || !row.snapshot) continue;
    const key = row.snapshot.entitlement;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return {
    environment: env,
    asOf: new Date(now).toISOString(),
    entitlements: [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([key, chains]) => {
      const active = chains.filter(row => validUntil(row.snapshot, now) !== null);
      const considered = active.length ? active : chains;
      const dates = considered.map(row => row.lastVerifiedAt?.getTime() ?? null);
      return {
        key, active: active.length > 0,
        validUntil: active.length ? new Date(Math.max(...active.map(row => validUntil(row.snapshot, now)!))).toISOString() : null,
        lastVerifiedAt: dates.includes(null) ? null : new Date(Math.min(...dates as number[])).toISOString(),
        stale: considered.some(row => isStale(row, now, interval)),
      };
    }),
  };
}
export function canReuse(row: SubscriptionRecord, input: VerifiedTransaction, userId: string, now: number, ttl = DEFAULT_REVERIFY_INTERVAL): boolean {
  const saved = row.snapshot;
  if (row.userId !== userId || !saved || row.verificationFailedAt || !row.lastVerifiedAt || now - row.lastVerifiedAt.getTime() >= ttl) return false;
  if (row.tokenJob?.mode === "transfer" && row.tokenSyncState !== "synced") return false;
  if (saved.transactionId !== input.transactionId || saved.productId !== input.productId || saved.revokedAt !== input.revokedAt || saved.isUpgraded !== input.isUpgraded || saved.appAccountToken !== input.appAccountToken || saved.expiresAt !== input.expiresAt) return false;
  const boundary = saved.status === 4 ? saved.graceExpiresAt : saved.expiresAt;
  return boundary !== null && boundary > now + DAY;
}
export function tokenAction(job: TokenJob, current: string | null): "done" | "write" | "blocked" {
  const value = current === null ? null : normalizeToken(current);
  if (value === normalizeToken(job.targetToken)) return "done";
  if (job.mode === "backfill") return value === null ? "write" : "blocked";
  return value === (job.expectedToken === null ? null : normalizeToken(job.expectedToken)) ? "write" : "blocked";
}
