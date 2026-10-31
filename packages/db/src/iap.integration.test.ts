import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { createAppStoreDrizzleStore } from "@northwind/better-auth-app-store/drizzle";
import { createAppStoreService } from "@northwind/better-auth-app-store/service";
import { AppStoreError } from "@northwind/better-auth-app-store";
import type { AppleGateway, AppStoreEnvironment, SubscriptionKey, VerifiedNotification, VerifiedSubscription } from "@northwind/better-auth-app-store/types";
import { iapTables } from "./schema/iap";
import { applyMigrationsFor } from "./testing";

// Never use DATABASE_URL: this suite truncates ONLY a separately provisioned test database.
const url = process.env.IAP_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite("App Store / real PostgreSQL", () => {
  if (url && (!['127.0.0.1', 'localhost', 'postgres'].includes(new URL(url).hostname) || new URL(url).pathname !== '/iap_test')) throw new Error("IAP_TEST_DATABASE_URL must reference the dedicated local iap_test database");
  const pool = new Pool({ connectionString: url, max: 4 });
  const pool2 = new Pool({ connectionString: url, max: 2 });
  const bundleId = "test.app";
  const makeStore = (second = false, bundle = bundleId) => createAppStoreDrizzleStore({ db: drizzle(second ? pool2 : pool), tables: iapTables, bundleId: bundle, environments: ["Production", "Sandbox"] });
  const store = makeStore(), other = makeStore(true);
  const states = new Map<string, VerifiedSubscription>();
  const notices = new Map<string, VerifiedNotification>();
  let calls = 0, writes = 0;
  let onWrite: ((key: SubscriptionKey, token: string) => Promise<void>) | null = null;
  let onRead: (() => Promise<void>) | null = null;
  const key = (id = "1", env: AppStoreEnvironment = "Production"): SubscriptionKey => ({ bundleId, environment: env, originalTransactionId: id });
  const mapKey = (item: SubscriptionKey) => `${item.environment}:${item.originalTransactionId}`;
  const fresh = (id = "1", token: string | null = null, env: AppStoreEnvironment = "Production"): VerifiedSubscription => ({ ...key(id, env), transactionId: `${id}1`, productId: "monthly", subscriptionGroupId: "100", entitlement: "pro", appAccountToken: token, status: 1, expiresAt: Date.now() + 7 * 86400_000, revokedAt: null, isUpgraded: false, autoRenew: true, graceExpiresAt: null });
  const put = (state: VerifiedSubscription) => { states.set(mapKey(state), state); return JSON.stringify(state); };
  const gateway: AppleGateway = {
    async transaction(value) { return JSON.parse(value); },
    async notification(value) { const n = notices.get(value); if (!n) throw new AppStoreError("INVALID_SIGNED_DATA"); return n; },
    async renewal() {},
    async current(item) { calls++; await onRead?.(); const state = states.get(mapKey(item)); if (!state) throw new AppStoreError("VERIFICATION_UNAVAILABLE"); return { ...state }; },
    async setToken(item, token) { writes++; if (onWrite) return onWrite(item, token); states.get(mapKey(item))!.appAccountToken = token; },
    async history() { return { signedPayloads: [], paginationToken: null }; },
    async testNotification() { return "test-token"; },
  };
  const service = createAppStoreService({ bundleId, environments: ["Production", "Sandbox"], store, gateway });
  const service2 = createAppStoreService({ bundleId, environments: ["Production", "Sandbox"], store: other, gateway });
  const notice = (uuid = crypto.randomUUID()): VerifiedNotification => ({ uuid, environment: "Production", type: "DID_RENEW", subtype: null, signedTransaction: put(states.get("Production:1") ?? fresh()), signedRenewal: null });
  beforeAll(async () => {
    await pool.query('CREATE TABLE IF NOT EXISTS "user" (id text PRIMARY KEY)');
    const exists = await pool.query("SELECT to_regclass('public.iap_account') AS name");
    if (!exists.rows[0].name) await applyMigrationsFor(pool, ["iap_account", "iap_notification", "iap_ownership_audit", "iap_subscription", "iap_sync_state"]);
    await store.assertSchema();
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE iap_notification, iap_subscription, iap_ownership_audit, iap_account, iap_sync_state, "user" CASCADE');
    await pool.query('INSERT INTO "user" (id) VALUES (\'alice\'), (\'bob\'), (\'carol\'), (\'operator\')');
    states.clear(); notices.clear(); calls = 0; writes = 0; onRead = null; onWrite = null;
  });
  afterAll(async () => { await pool.end(); await pool2.end(); });
  test("stable account UUID with simultaneous requests, app and environment isolation", async () => {
    const accounts = await Promise.all([store.account("alice"), other.account("alice")]);
    expect(accounts[0]!.appAccountToken).toBe(accounts[1]!.appAccountToken);
    expect((await store.accountByToken(accounts[0]!.appAccountToken.toUpperCase()))?.userId).toBe("alice");
    expect(await makeStore(false, "different.app").accountByToken(accounts[0]!.appAccountToken)).toBeNull();
    await service.sync("alice", put(fresh("1", accounts[0]!.appAccountToken)));
    expect((await service.status("alice", "Sandbox")).entitlements).toEqual([]);
    await expect(store.subscription({ ...key(), bundleId: "different.app" })).rejects.toMatchObject({ code: "INVALID_ENVIRONMENT" });
  });
  test("normal sync cannot claim guest purchases; explicit restore can and then deduplicates", async () => {
    const signed = put(fresh());
    await expect(service.sync("alice", signed)).rejects.toMatchObject({ code: "RESTORE_REQUIRED" });
    expect((await store.subscription(key()))?.claimedAt).toBeNull();
    const restored = await service.sync("alice", signed, true);
    expect(restored).toMatchObject({ binding: "bound", tokenSyncState: "pending" });
    expect((await store.subscription(key()))?.ownershipVersion).toBe(1);
    const count = calls;
    await service.sync("alice", signed);
    expect(calls).toBe(count);
    await service.syncToken(key());
    expect(writes).toBe(1);
    expect((await store.subscription(key()))?.tokenSyncState).toBe("synced");
  });
  test("two database connections cannot claim the same unbound chain", async () => {
    const signed = put(fresh());
    const results = await Promise.allSettled([service.sync("alice", signed, true), service2.sync("bob", signed, true)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const row = (await store.subscription(key()))!;
    expect(["alice", "bob"]).toContain(row.userId!);
    await expect(service.sync(row.userId === "alice" ? "bob" : "alice", signed, true)).rejects.toMatchObject({ code: "SUBSCRIPTION_OWNERSHIP_CONFLICT" });
  });
  test("expired, revoked and unknown tokens cannot be first-claimed", async () => {
    for (const [id, changes, code] of [["1", { expiresAt: Date.now() - 1 }, "NO_ACTIVE_SUBSCRIPTION"], ["2", { revokedAt: Date.now() }, "NO_ACTIVE_SUBSCRIPTION"], ["3", { appAccountToken: crypto.randomUUID() }, "APP_ACCOUNT_TOKEN_UNKNOWN"]] as const) {
      await expect(service.sync("alice", put({ ...fresh(id), ...changes }), true)).rejects.toMatchObject({ code });
      expect((await store.subscription(key(id)))?.userId).toBeNull();
    }
  });
  test("deleted account leaves a tombstone and cannot be reclaimed by restore", async () => {
    const signed = put(fresh()); await service.sync("alice", signed, true);
    await pool.query('DELETE FROM "user" WHERE id = $1', ["alice"]);
    const row = (await store.subscription(key()))!;
    expect(row.userId).toBeNull(); expect(row.claimedAt).not.toBeNull();
    await expect(service.sync("bob", signed, true)).rejects.toMatchObject({ code: "SUBSCRIPTION_OWNERSHIP_ORPHANED" });
    await expect(service.transfer(key(), { toUserId: "bob", operatorUserId: "operator", reason: "Verified support recovery" })).resolves.toMatchObject({ userId: "bob", ownershipVersion: 2 });
  });
  test("expired lease cannot overwrite a newer owner or release the new lease", async () => {
    const old = (await store.acquire(key()))!;
    await pool.query("UPDATE iap_subscription SET lease_expires_at = now() - interval '1 second'");
    const latest = (await other.acquire(key()))!;
    await other.commit(latest, fresh(), "bob", null);
    await expect(store.commit(old, fresh(), "alice", null)).rejects.toMatchObject({ code: "PROCESSING_BUSY" });
    await store.release(old);
    expect((await store.subscription(key()))?.leaseOwner).toBe(latest.owner);
    await other.release(latest);
  });
  test("deleted token owner before first delivery is recoverable only through audited support", async () => {
    const account = await store.account("alice");
    await pool.query('DELETE FROM "user" WHERE id = $1', ["alice"]);
    const signed = put(fresh("1", account.appAccountToken));
    await expect(service.sync("bob", signed, true)).rejects.toMatchObject({ code: "SUBSCRIPTION_OWNERSHIP_ORPHANED" });
    await service.transfer(key(), { toUserId: "bob", operatorUserId: "operator", reason: "Verified deleted account purchase" });
    expect((await store.subscription(key()))?.claimedAt).not.toBeNull();
    await service.syncToken(key()); expect(writes).toBe(1);
    put(fresh("2"));
    await expect(service.transfer(key("2"), { toUserId: "bob", operatorUserId: "operator", reason: "No original owner proof" })).rejects.toMatchObject({ code: "TOKEN_TRANSFER_BLOCKED" });
  });
  test("notification completion and subscription projection roll back together", async () => {
    const n = notice(); await store.acceptNotification(n, "signed");
    const notification = (await store.nextNotification())!;
    await pool.query("UPDATE iap_notification SET lease_expires_at = now() - interval '1 second'");
    const lease = (await store.acquire(key()))!;
    await expect(store.commit(lease, fresh(), "alice", null, notification)).rejects.toMatchObject({ code: "PROCESSING_BUSY" });
    expect((await store.subscription(key()))?.snapshot).toBeNull();
    await store.release(lease);
  });
  test("duplicate and out-of-order notices converge to current Apple state", async () => {
    const account = await store.account("alice"); put(fresh("1", account.appAccountToken));
    const n = notice(); notices.set("signed", n);
    await Promise.all([service.accept("signed"), service2.accept("signed")]);
    expect((await store.metrics()).pendingNotifications).toBe(1);
    const leased = await Promise.all([store.nextNotification(), other.nextNotification()]);
    expect(leased.filter(Boolean)).toHaveLength(1);
    states.get("Production:1")!.revokedAt = Date.now();
    await service.notification(leased.find(Boolean)!);
    expect((await store.metrics()).pendingNotifications).toBe(0);
    expect((await store.subscription(key()))?.userId).toBeNull();
  });
  test("notification retry and dead-letter do not discard the signed payload", async () => {
    const n = notice(); await store.acceptNotification(n, "signed");
    const lease = (await store.nextNotification())!;
    await store.failNotification(lease, "VERIFICATION_UNAVAILABLE", true);
    expect(await store.nextNotification()).toBeNull();
    await pool.query("UPDATE iap_notification SET next_attempt_at = now() - interval '1 second', attempts = 11");
    await service.notification((await store.nextNotification())!);
    const result = await pool.query("SELECT status, signed_payload FROM iap_notification");
    expect(result.rows[0]).toEqual({ status: "dead", signed_payload: "signed" });
  });
  test("ownership transfer and audit commit atomically, then token writes use the expected owner", async () => {
    const a = await store.account("alice"), b = await store.account("bob");
    await service.sync("alice", put(fresh("1", a.appAccountToken)));
    await expect(service.transfer(key(), { toUserId: "bob", operatorUserId: "operator", reason: "Support verified" })).rejects.toMatchObject({ code: "TOKEN_TRANSFER_BLOCKED" });
    await service.transfer(key(), { toUserId: "bob", fromUserId: "alice", operatorUserId: "operator", reason: "Support verified" });
    const row = (await store.subscription(key()))!;
    expect(row.tokenJob).toMatchObject({ mode: "transfer", expectedToken: a.appAccountToken, targetToken: b.appAccountToken, ownershipVersion: 2 });
    expect(await store.audit(row)).toMatchObject({ toUserId: "bob", ownershipVersion: 2 });
    expect((await service.status("alice")).entitlements).toEqual([]);
    await service.syncToken(key()); expect(writes).toBe(1);
    expect((await store.subscription(key()))?.tokenSyncState).toBe("synced");
  });
  test("a failed transfer transaction leaves neither audit nor owner change", async () => {
    await service.sync("alice", put(fresh()), true);
    const old = (await store.acquire(key()))!;
    await pool.query("UPDATE iap_subscription SET version = version + 1");
    await expect(store.transfer(old, { toUserId: "bob", targetToken: (await store.account("bob")).appAccountToken, expectedToken: null, operatorUserId: "operator", reason: "test" })).rejects.toMatchObject({ code: "PROCESSING_BUSY" });
    expect((await pool.query("SELECT * FROM iap_ownership_audit")).rows).toHaveLength(0);
    expect((await store.subscription(key()))?.userId).toBe("alice");
  });
  test("a delayed old token is repaired from the audit while the old account remains denied", async () => {
    const a = await store.account("alice");
    const signed = put(fresh("1", a.appAccountToken));
    await service.sync("alice", signed);
    await service.transfer(key(), { toUserId: "bob", fromUserId: "alice", operatorUserId: "operator", reason: "Support verified" });
    await service.syncToken(key());
    states.get("Production:1")!.appAccountToken = a.appAccountToken;
    expect(await service.sync("bob", signed)).toMatchObject({ binding: "bound", tokenSyncState: "pending" });
    await expect(service.sync("alice", signed)).rejects.toMatchObject({ code: "SUBSCRIPTION_OWNERSHIP_CONFLICT" });
    await service.syncToken(key()); expect(writes).toBe(2);
    expect((await store.subscription(key()))?.userId).toBe("bob");
  });
  test("notification contention retries and later revokes an already linked subscription", async () => {
    const a = await store.account("alice");
    const signed = put(fresh("1", a.appAccountToken));
    await service.sync("alice", signed);
    const n = notice(); notices.set("signed", n); await service.accept("signed");
    const held = (await other.acquire(key()))!;
    await service.notification((await store.nextNotification())!);
    expect((await store.metrics()).pendingNotifications).toBe(1);
    await other.release(held);
    await pool.query("UPDATE iap_notification SET next_attempt_at = now() - interval '1 second'");
    states.get("Production:1")!.revokedAt = Date.now();
    await service.notification((await store.nextNotification())!);
    expect((await service.status("alice")).entitlements[0]?.active).toBe(false);
    expect((await store.metrics()).pendingNotifications).toBe(0);
  });
  test("write timeout resumes with a read and does not repeat a successful side effect", async () => {
    await service.sync("alice", put(fresh()), true);
    onWrite = async (item, token) => { states.get(mapKey(item))!.appAccountToken = token; throw new AppStoreError("VERIFICATION_UNAVAILABLE"); };
    await expect(service.syncToken(key())).rejects.toMatchObject({ code: "VERIFICATION_UNAVAILABLE" });
    expect((await store.subscription(key()))?.tokenSyncState).toBe("verify_pending");
    await service.syncToken(key());
    expect(writes).toBe(1); expect((await store.subscription(key()))?.tokenSyncState).toBe("synced");
  });
  test("third-party tokens before or after a write block further writes", async () => {
    await service.sync("alice", put(fresh()), true);
    states.get("Production:1")!.appAccountToken = crypto.randomUUID();
    await service.syncToken(key()); expect(writes).toBe(0);
    expect((await store.subscription(key()))?.tokenSyncState).toBe("blocked");
    await service.sync("alice", put(fresh("2")), true);
    onWrite = async item => { states.get(mapKey(item))!.appAccountToken = crypto.randomUUID(); };
    await expect(service.syncToken(key("2"))).rejects.toMatchObject({ code: "TOKEN_TRANSFER_BLOCKED" });
    expect((await store.subscription(key("2")))?.tokenSyncState).toBe("blocked");
  });
  test("stale token job versions stop instead of spinning forever", async () => {
    await service.sync("alice", put(fresh()), true);
    await pool.query("UPDATE iap_subscription SET token_sync_ownership_version = 0");
    await expect(service.syncToken(key())).rejects.toMatchObject({ code: "TOKEN_TRANSFER_BLOCKED" });
    expect(await store.dueTokens(50)).toEqual([]);
    expect((await store.subscription(key()))?.tokenSyncState).toBe("blocked");
  });
  test("history pagination is atomic with the inbox and retains a fixed window", async () => {
    const first = (await store.acquireHistory("Production"))!;
    expect(first.windowStart.getTime()).toBeGreaterThan(Date.now() - 8 * 86400_000);
    expect(first.windowStart.getTime()).toBeLessThan(Date.now() - 6 * 86400_000);
    const n = notice(); await store.commitHistory(first, [{ notification: n, signedPayload: "signed" }], "page-2");
    const next = (await other.acquireHistory("Production"))!;
    expect(next.windowStart.getTime()).toBe(first.windowStart.getTime()); expect(next.windowEnd.getTime()).toBe(first.windowEnd.getTime());
    expect(next.paginationToken).toBe("page-2");
    const extra = notice();
    await pool.query("UPDATE iap_sync_state SET lease_expires_at = now() - interval '1 second'");
    await expect(store.commitHistory(next, [{ notification: extra, signedPayload: "extra" }], null)).rejects.toMatchObject({ code: "PROCESSING_BUSY" });
    expect((await store.metrics()).pendingNotifications).toBe(1);
    const retry = (await store.acquireHistory("Production"))!;
    await store.commitHistory(retry, [{ notification: n, signedPayload: "signed" }], null);
    const row = (await pool.query("SELECT * FROM iap_sync_state")).rows[0];
    expect(row.completed_through.getTime()).toBe(first.windowEnd.getTime()); expect(row.window_end).toBeNull();
  });
  test("aged history resets its cursor, reports a coverage gap and respects Sandbox retention", async () => {
    await store.acquireHistory("Sandbox");
    await pool.query("UPDATE iap_sync_state SET window_start = now() - interval '31 days', window_end = now() - interval '1 day', pagination_token = 'expired', lease_expires_at = now() - interval '1 second'");
    const next = (await store.acquireHistory("Sandbox"))!;
    expect(next.windowStart.getTime()).toBeGreaterThan(Date.now() - 30 * 86400_000);
    expect(next.paginationToken).toBeNull();
    expect((await pool.query("SELECT coverage_gap_at FROM iap_sync_state")).rows[0].coverage_gap_at).not.toBeNull();
  });
  test("more than 200 expired chains progress through the bounded reconcile queue", async () => {
    await pool.query("INSERT INTO iap_subscription (id,bundle_id,environment,original_transaction_id,user_id,claimed_at) SELECT md5(i::text)::uuid,$1,'Production',i::text,'alice',now() FROM generate_series(1,205) i", [bundleId]);
    for (let i = 1; i <= 205; i++) put({ ...fresh(String(i)), status: 2, expiresAt: Date.now() - 86400_000 });
    const first = await store.dueSubscriptions(200); expect(first).toHaveLength(200);
    for (const item of first) await service.reconcile(item);
    expect(await store.dueSubscriptions(200)).toHaveLength(5);
    const earliest = (await pool.query("SELECT min(next_reconcile_at) AS next FROM iap_subscription WHERE snapshot IS NOT NULL")).rows[0].next;
    expect(earliest.getTime()).toBeGreaterThan(Date.now());
  });
  test("shared rate admission and Retry-After backoff are visible across pools", async () => {
    const delays = await Promise.all([store.reserveAppleCall("Sandbox"), other.reserveAppleCall("Sandbox")]);
    expect(Math.max(...delays)).toBeGreaterThan(500);
    await store.deferAppleCalls("Production", new Date(Date.now() + 60000));
    await expect(other.reserveAppleCall("Production")).rejects.toMatchObject({ code: "VERIFICATION_UNAVAILABLE" });
  });
  test("permanent API failures await regular reconciliation while transient failures retry sooner", async () => {
    const account = await store.account("alice");
    await service.sync("alice", put(fresh("1", account.appAccountToken)));
    onRead = async () => { throw new AppStoreError("VERIFICATION_UNAVAILABLE", { appleHttpStatus: 403, retryable: false }); };
    await expect(service.reconcile(key())).rejects.toMatchObject({ retryable: false });
    const permanent = (await store.subscription(key()))!;
    expect(permanent.nextReconcileAt.getTime()).toBeGreaterThan(Date.now() + 5 * 3600_000);
    expect((await service.status("alice")).entitlements[0]).toMatchObject({ active: true, stale: true });
    onRead = async () => { throw new AppStoreError("VERIFICATION_UNAVAILABLE", { retryable: true }); };
    await expect(service.reconcile(key())).rejects.toMatchObject({ retryable: true });
    const transient = (await store.subscription(key()))!;
    expect(transient.nextReconcileAt.getTime()).toBeLessThan(Date.now() + 5 * 60_000);
    expect(transient.snapshot).toEqual(permanent.snapshot);
  });
  test("history distinguishes permanent configuration failures from invalid pagination", async () => {
    const first = (await store.acquireHistory("Production"))!;
    await store.commitHistory(first, [], "page-2");
    let code = 4030001;
    const failing = createAppStoreService({ bundleId, environments: ["Production"], store,
      gateway: { ...gateway, async history() { throw new AppStoreError("VERIFICATION_UNAVAILABLE", { appleCode: code, retryable: false }); } },
    });
    await failing.recover("Production");
    const permanent = (await pool.query("SELECT * FROM iap_sync_state")).rows[0];
    expect(permanent.next_run_at.getTime()).toBeGreaterThan(Date.now() + 5 * 3600_000);
    expect(permanent.pagination_token).toBe("page-2");
    code = 4000017;
    await pool.query("UPDATE iap_sync_state SET next_run_at = now() - interval '1 second'");
    await failing.recover("Production");
    const reset = (await pool.query("SELECT * FROM iap_sync_state")).rows[0];
    expect(reset.next_run_at.getTime()).toBeLessThan(Date.now() + 2 * 60_000);
    expect(reset.pagination_token).toBeNull();
    expect(reset.window_start.getTime()).toBe(first.windowStart.getTime());
    expect(reset.window_end.getTime()).toBe(first.windowEnd.getTime());
  });
  test("startup detects an index with the right name but without uniqueness", async () => {
    await pool.query('DROP INDEX iap_account_token_uidx; CREATE INDEX iap_account_token_uidx ON iap_account(bundle_id,app_account_token)');
    try { await expect(store.assertSchema()).rejects.toThrow("index missing or incompatible"); }
    finally { await pool.query('DROP INDEX iap_account_token_uidx; CREATE UNIQUE INDEX iap_account_token_uidx ON iap_account(bundle_id,app_account_token)'); }
  });
});
