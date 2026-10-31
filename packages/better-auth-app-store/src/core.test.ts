import { describe, expect, test } from "bun:test";
import { canReuse, DAY, HOUR, nextReconcileAt, normalizeToken, statusFor, tokenAction, validUntil } from "./core";
import { concurrencyGate } from "./concurrency";
import type { SubscriptionRecord, TokenJob, VerifiedSubscription } from "./types";

const now = Date.parse("2026-09-11T00:00:00Z");
const token = "00112233-4455-6677-8899-aabbccddeeff";
const snapshot: VerifiedSubscription = {
  bundleId: "test.app", environment: "Production", originalTransactionId: "1", transactionId: "2",
  productId: "monthly", subscriptionGroupId: "100", appAccountToken: token, expiresAt: now + 3 * DAY,
  revokedAt: null, isUpgraded: false, status: 1, graceExpiresAt: null, autoRenew: false, entitlement: "pro",
};
const row: SubscriptionRecord = {
  ...snapshot, id: crypto.randomUUID(), userId: "alice", claimedAt: new Date(now - DAY), ownershipVersion: 1,
  snapshot, lastVerifiedAt: new Date(now - 60_000), verificationFailedAt: null, version: 1,
  leaseOwner: null, leaseExpiresAt: null, nextReconcileAt: new Date(now), reconcileAttempts: 0,
  tokenJob: null, tokenSyncState: "none", tokenSyncAttempts: 0, tokenSyncNextAttemptAt: null,
};
describe("entitlement validity", () => {
  test("auto-renew off still grants until expiration, with an exclusive deadline", () => {
    expect(validUntil(snapshot, now)).toBe(snapshot.expiresAt);
    expect(validUntil(snapshot, snapshot.expiresAt!)).toBeNull();
  });
  test.each([2, 3, 5, 99])("status %s never grants even with a future expiration", status => {
    expect(validUntil({ ...snapshot, status }, now)).toBeNull();
  });
  test("grace uses its own deadline; refunds and superseded upgrades revoke immediately", () => {
    expect(validUntil({ ...snapshot, status: 4, expiresAt: now - 1, graceExpiresAt: now + HOUR }, now)).toBe(now + HOUR);
    expect(validUntil({ ...snapshot, status: 4, graceExpiresAt: now }, now)).toBeNull();
    expect(validUntil({ ...snapshot, revokedAt: now }, now)).toBeNull();
    expect(validUntil({ ...snapshot, isUpgraded: true }, now)).toBeNull();
  });
  test("aggregates active chains and excludes other environments", () => {
    const result = statusFor([row, { ...row, snapshot: { ...snapshot, expiresAt: now + 4 * DAY } }, { ...row, environment: "Sandbox", snapshot: { ...snapshot, expiresAt: now + 100 * DAY } }], "Production", now);
    expect(result.entitlements).toEqual([{ key: "pro", active: true, validUntil: new Date(now + 4 * DAY).toISOString(), lastVerifiedAt: row.lastVerifiedAt!.toISOString(), stale: false }]);
    expect(JSON.stringify(result)).not.toContain("alice");
    expect(JSON.stringify(result)).not.toContain(token);
  });
  test("verification failure marks stale but never extends a proven deadline", () => {
    const failed = { ...row, verificationFailedAt: new Date(now) };
    expect(statusFor([failed], "Production", now).entitlements[0]?.stale).toBe(true);
    expect(statusFor([failed], "Production", now + 4 * DAY).entitlements[0]?.active).toBe(false);
  });
});
test("every reconcile successor is in the future, including already expired chains", () => {
  for (const status of [1, 2, 3, 4, 5, 99]) for (const offset of [-10 * DAY, -HOUR, -1, 0, 1, HOUR, 10 * DAY]) {
    const date = nextReconcileAt({ ...snapshot, status, expiresAt: now + offset, graceExpiresAt: now + offset }, now).getTime();
    expect(date).toBeGreaterThan(now);
    expect(date).toBeLessThanOrEqual(now + 6 * HOUR);
  }
});
test("TTL bypasses changed transactions, refunds, upgrades, failures and near expiration", () => {
  expect(canReuse(row, snapshot, "alice", now)).toBe(true);
  for (const input of [{ ...snapshot, transactionId: "3" }, { ...snapshot, revokedAt: now }, { ...snapshot, isUpgraded: true }, { ...snapshot, productId: "Annual" }]) expect(canReuse(row, input, "alice", now)).toBe(false);
  expect(canReuse(row, snapshot, "bob", now)).toBe(false);
  expect(canReuse(row, snapshot, "alice", now + 15 * 60_000)).toBe(false);
  expect(canReuse({ ...row, verificationFailedAt: new Date(now) }, snapshot, "alice", now)).toBe(false);
  const near = { ...snapshot, expiresAt: now + HOUR };
  expect(canReuse({ ...row, snapshot: near }, near, "alice", now)).toBe(false);
});
test("token backfill never overwrites another owner; audited transfer only replaces its expected token", () => {
  const old = crypto.randomUUID(), third = crypto.randomUUID();
  const backfill: TokenJob = { mode: "backfill", expectedToken: null, targetToken: token, ownershipVersion: 1, auditId: null };
  const transfer: TokenJob = { ...backfill, mode: "transfer", expectedToken: old, auditId: crypto.randomUUID() };
  expect(normalizeToken(token.toUpperCase())).toBe(token);
  expect(() => normalizeToken("invalid")).toThrow();
  expect(tokenAction(backfill, null)).toBe("write");
  expect(tokenAction(backfill, old)).toBe("blocked");
  expect(tokenAction(transfer, old.toUpperCase())).toBe("write");
  expect(tokenAction(transfer, third)).toBe("blocked");
  expect(tokenAction(transfer, null)).toBe("blocked");
  expect(tokenAction(transfer, token.toUpperCase())).toBe("done");
});
test("concurrency admission is bounded and releases after rejection", async () => {
  const gate = concurrencyGate(1);
  let release!: () => void;
  const held = gate(() => new Promise<void>(resolve => { release = resolve; }));
  await expect(gate(async () => 1)).rejects.toMatchObject({ code: "VERIFICATION_UNAVAILABLE" });
  release(); await held;
  await expect(gate(async () => { throw new Error("network"); })).rejects.toThrow("network");
  expect(await gate(async () => 42)).toBe(42);
});
