import { canReuse, DEFAULT_RECONCILE_INTERVAL, DEFAULT_REVERIFY_INTERVAL, environment, normalizeToken, statusFor, tokenAction, validUntil } from "./core";
import { AppStoreError, asAppStoreError } from "./errors";
import type {
  AppStoreEnvironment, AppStoreEvent, AppStoreServiceOptions, AppStoreSyncResult, NotificationLease,
  SubscriptionKey, SubscriptionLease, SubscriptionRecord, TokenJob, VerifiedSubscription, VerifiedTransaction,
} from "./types";

const lifecycleNotifications = new Set([
  "SUBSCRIBED", "DID_RENEW", "DID_CHANGE_RENEWAL_PREF", "DID_CHANGE_RENEWAL_STATUS",
  "OFFER_REDEEMED", "DID_FAIL_TO_RENEW", "GRACE_PERIOD_EXPIRED", "EXPIRED", "PRICE_INCREASE",
  "REFUND", "REFUND_DECLINED", "REFUND_REVERSED", "REVOKE", "RENEWAL_EXTENDED", "RENEWAL_EXTENSION",
]);
type Actor = { kind: "sync" | "restore"; userId: string } | { kind: "notification" | "reconcile" };

export function createAppStoreService(options: AppStoreServiceOptions) {
  const { store, gateway } = options;
  const interval = options.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL;
  const ttl = options.reverifyIntervalMs ?? DEFAULT_REVERIFY_INTERVAL;
  if (!Number.isSafeInteger(interval) || interval <= 0 || !Number.isSafeInteger(ttl) || ttl <= 0) throw new Error("App Store verification intervals must be positive integers");
  const counts = new Map<string, number>();
  const event = (name: string, code?: string, env?: AppStoreEnvironment, details?: Pick<AppStoreEvent, "appleCode" | "appleHttpStatus" | "verificationStatus">) => {
    counts.set(`${name}${code ? `:${code}` : ""}`, (counts.get(`${name}${code ? `:${code}` : ""}`) ?? 0) + 1);
    options.onEvent?.({ name, code, environment: env, ...details });
  };
  const assertOwner = (row: SubscriptionRecord, userId: string) => {
    if (!row.claimedAt) return;
    if (row.userId === null) throw new AppStoreError("SUBSCRIPTION_OWNERSHIP_ORPHANED");
    if (row.userId !== userId) throw new AppStoreError("SUBSCRIPTION_OWNERSHIP_CONFLICT");
  };
  const validJob = async (row: SubscriptionRecord): Promise<TokenJob | null> => {
    const job = row.tokenJob;
    if (!job || !row.userId || job.ownershipVersion !== row.ownershipVersion) return null;
    const account = await store.accountByToken(job.targetToken);
    if (account?.userId !== row.userId) return null;
    if (job.mode === "transfer") {
      const audit = await store.audit(row);
      if (!audit || audit.toUserId !== row.userId || audit.targetToken !== job.targetToken || audit.expectedToken !== job.expectedToken || audit.ownershipVersion !== row.ownershipVersion) return null;
    }
    return job;
  };
  const agreesWithOwner = async (row: SubscriptionRecord, current: VerifiedSubscription, userId: string) => {
    if (current.appAccountToken === null) return;
    const target = await store.account(userId);
    if (target.appAccountToken === current.appAccountToken) return;
    const job = await validJob(row);
    if (job?.mode === "transfer" && job.expectedToken === current.appAccountToken) return;
    const account = await store.accountByToken(current.appAccountToken);
    throw new AppStoreError(account ? "SUBSCRIPTION_OWNERSHIP_CONFLICT" : "APP_ACCOUNT_TOKEN_UNKNOWN");
  };
  async function process(lease: SubscriptionLease, actor: Actor, notification?: NotificationLease) {
    const row = lease.record;
    if ("userId" in actor) assertOwner(row, actor.userId);
    event("AppleVerifyRequested");
    const current = await gateway.current(row);
    let userId = row.userId;
    if (!row.claimedAt) {
      if (current.appAccountToken !== null) {
        const account = await store.accountByToken(current.appAccountToken);
        if (!account) throw new AppStoreError("APP_ACCOUNT_TOKEN_UNKNOWN");
        if (!account.userId) throw new AppStoreError("SUBSCRIPTION_OWNERSHIP_ORPHANED");
        if ("userId" in actor && actor.userId !== account.userId) throw new AppStoreError("SUBSCRIPTION_OWNERSHIP_CONFLICT");
        userId = account.userId;
      } else if (actor.kind === "restore") {
        userId = actor.userId;
      } else if (actor.kind === "sync") {
        throw new AppStoreError("RESTORE_REQUIRED");
      }
      if (userId !== null && validUntil(current, Date.now()) === null) {
        if ("userId" in actor) throw new AppStoreError("NO_ACTIVE_SUBSCRIPTION");
        userId = null;
      }
    }
    if (userId) await agreesWithOwner(row, current, userId);
    let job: TokenJob | null = null;
    if (userId && current.appAccountToken === null && row.tokenJob === null) {
      const account = await store.account(userId);
      job = { mode: "backfill", expectedToken: null, targetToken: account.appAccountToken, ownershipVersion: row.ownershipVersion + (row.claimedAt ? 0 : 1), auditId: null };
    }
    const result = await store.commit(lease, current, userId, job, notification);
    const transfer = await validJob(result);
    if (transfer?.mode === "transfer" && result.tokenSyncState === "synced" && current.appAccountToken === transfer.expectedToken && current.appAccountToken !== transfer.targetToken) {
      await store.tokenState({ ...lease, record: result }, "pending");
      result.tokenSyncState = "pending";
    }
    if (![1, 2, 3, 4, 5].includes(current.status)) event("UnknownAppleStatus");
    return result;
  }
  async function withLease<T>(key: SubscriptionKey, work: (lease: SubscriptionLease) => Promise<T>): Promise<T> {
    const lease = await store.acquire(key);
    if (!lease) throw new AppStoreError("PROCESSING_BUSY");
    try { return await work(lease); }
    catch (error) {
      const failure = asAppStoreError(error);
      if (failure.code !== "PROCESSING_BUSY") await store.fail(lease, failure.code, failure.retryable);
      throw failure;
    } finally { await store.release(lease); }
  }
  function tokenResult(row: SubscriptionRecord): AppStoreSyncResult["tokenSyncState"] {
    if (row.tokenSyncState === "blocked" || row.tokenSyncState === "not_applicable") return "blocked";
    return ["none", "synced"].includes(row.tokenSyncState) ? "synced" : "pending";
  }
  const service = {
    event,
    ready: () => store.assertSchema(),
    async accountToken(userId: string) { return { appAccountToken: (await store.account(userId)).appAccountToken }; },
    async status(userId: string, requested: unknown = "Production") {
      const env = environment(requested, options.environments);
      return statusFor(await store.subscriptions(userId, env), env, Date.now(), interval);
    },
    async sync(userId: string, signed: string, restore = false): Promise<AppStoreSyncResult> {
      try {
        const input: VerifiedTransaction = await gateway.transaction(signed);
        const existing = await store.subscription(input);
        if (existing) {
          assertOwner(existing, userId);
          if (!restore && canReuse(existing, input, userId, Date.now(), ttl)) {
            event("SyncShortCircuited");
            return { binding: "bound", tokenSyncState: tokenResult(existing), status: await service.status(userId, input.environment) };
          }
        }
        const row = await withLease(input, lease => process(lease, { kind: restore ? "restore" : "sync", userId }));
        return { binding: "bound", tokenSyncState: tokenResult(row), status: await service.status(userId, input.environment) };
      } catch (error) {
        const failure = asAppStoreError(error);
        event("SyncFailed", failure.code);
        throw failure;
      }
    },
    async accept(signed: string) {
      const notification = await gateway.notification(signed);
      await store.acceptNotification(notification, signed);
      event("NotificationAccepted");
      return { accepted: true as const };
    },
    async notification(lease: NotificationLease) {
      try {
        if (!lease.signedPayload) throw new AppStoreError("INVALID_SIGNED_DATA");
        const decoded = await gateway.notification(lease.signedPayload, true);
        if (decoded.environment !== lease.environment || normalizeToken(decoded.uuid) !== normalizeToken(lease.notificationUuid)) throw new AppStoreError("INVALID_SIGNED_DATA");
        if (!lifecycleNotifications.has(decoded.type) || !decoded.signedTransaction) {
          await store.finishNotification(lease, "ignored", decoded.type === "TEST" ? "TEST" : "UNSUPPORTED_NOTIFICATION");
          return;
        }
        const input = await gateway.transaction(decoded.signedTransaction, true);
        if (input.environment !== lease.environment) throw new AppStoreError("INVALID_SIGNED_DATA");
        if (decoded.signedRenewal) await gateway.renewal(decoded.signedRenewal, input.environment, input.originalTransactionId, true);
        await withLease(input, subscriptionLease => process(subscriptionLease, { kind: "notification" }, lease));
        event("NotificationProcessed");
      } catch (error) {
        const failure = asAppStoreError(error);
        await store.failNotification(lease, failure.code, failure.retryable);
        event("NotificationFailed", failure.code);
      }
    },
    async reconcile(key: SubscriptionKey) {
      return withLease(key, lease => process(lease, { kind: "reconcile" }));
    },
    async syncToken(key: SubscriptionKey) {
      await withLease(key, async lease => {
        let row = lease.record;
        try {
          const job = await validJob(row);
          if (!job || !row.userId) throw new AppStoreError("TOKEN_TRANSFER_BLOCKED");
          const current = await gateway.current(key);
          const target = normalizeToken(job.targetToken);
          if (tokenAction(job, current.appAccountToken) === "blocked") {
            await store.tokenState(lease, "blocked", "TOKEN_TRANSFER_BLOCKED");
            event("TokenSyncBlocked");
            return;
          }
          row = await store.commit(lease, current, row.userId, null);
          lease = { ...lease, record: row };
          if (current.appAccountToken !== target) {
            // Persist intent before the external side effect; a crash resumes with a read.
            await store.tokenState(lease, "writing");
            await gateway.setToken(key, target);
            const verified = await gateway.current(key);
            if (tokenAction(job, verified.appAccountToken) === "blocked") throw new AppStoreError("TOKEN_TRANSFER_BLOCKED");
            row = await store.commit(lease, verified, row.userId, null);
            if (verified.appAccountToken !== target) {
              await store.tokenState(lease, "verify_pending", "VERIFICATION_UNAVAILABLE");
              return;
            }
          }
          await store.tokenState(lease, "synced");
          event("TokenSynced");
        } catch (error) {
          const failure = asAppStoreError(error);
          await store.tokenState(lease, failure.code === "UNSUPPORTED_PURCHASE" ? "not_applicable" : failure.retryable ? "verify_pending" : "blocked", failure.code);
          event("TokenSyncFailed", failure.code);
          throw failure;
        }
      });
    },
    async transfer(key: SubscriptionKey, input: { toUserId: string; fromUserId?: string; operatorUserId: string; reason: string }) {
      if (!input.reason.trim() || input.reason.length > 1000) throw new AppStoreError("TOKEN_TRANSFER_BLOCKED");
      return withLease(key, async lease => {
        const row = lease.record;
        if ((row.userId !== null && input.fromUserId !== row.userId) || row.userId === input.toUserId || ["writing", "verify_pending"].includes(row.tokenSyncState)) throw new AppStoreError("TOKEN_TRANSFER_BLOCKED");
        const current = await gateway.current(key);
        if (!row.claimedAt) {
          // The account may have been deleted after obtaining its token but before
          // the first transaction arrived. Only its retained token tombstone is recoverable.
          const original = current.appAccountToken ? await store.accountByToken(current.appAccountToken) : null;
          if (!original || original.userId !== null) throw new AppStoreError("TOKEN_TRANSFER_BLOCKED");
        }
        const target = await store.account(input.toUserId);
        const result = await store.transfer(lease, { ...input, reason: input.reason.trim(), expectedToken: current.appAccountToken, targetToken: target.appAccountToken });
        event("OwnershipTransferred");
        return { userId: result.userId, ownershipVersion: result.ownershipVersion, tokenSyncState: "pending" as const };
      });
    },
    async recover(env: AppStoreEnvironment) {
      const lease = await store.acquireHistory(env);
      if (!lease) return;
      try {
        const page = await gateway.history(lease);
        const notifications = [];
        for (const signedPayload of page.signedPayloads) notifications.push({ signedPayload, notification: await gateway.notification(signedPayload, true) });
        await store.commitHistory(lease, notifications, page.paginationToken);
        event("HistoryPageRecovered");
      } catch (error) {
        const failure = asAppStoreError(error);
        const resetPage = failure.appleCode === 4000017 || failure.appleCode === 4000014;
        await store.failHistory(lease, resetPage, resetPage || failure.retryable);
        event("HistoryRecoveryFailed", failure.code);
      }
    },
    async maintain(shouldStop: () => boolean = () => false) {
      const safely = async (work: () => Promise<unknown>) => {
        try { await work(); } catch (error) { event("MaintenanceFailed", asAppStoreError(error).code); }
      };
      for (let i = 0; i < 50 && !shouldStop(); i++) {
        const lease = await store.nextNotification();
        if (!lease) break;
        await service.notification(lease);
      }
      if (shouldStop()) return;
      for (const key of await store.dueTokens(50)) {
        if (shouldStop()) return;
        await safely(() => service.syncToken(key));
      }
      for (const key of await store.dueSubscriptions(200)) {
        if (shouldStop()) return;
        await safely(() => service.reconcile(key));
      }
      for (const env of options.environments) {
        if (shouldStop()) return;
        await safely(() => service.recover(env));
      }
      if (!shouldStop()) await store.cleanup();
    },
    async metrics() { return { counters: Object.fromEntries(counts), ...await store.metrics() }; },
    testNotification: (env: AppStoreEnvironment) => gateway.testNotification(environment(env, options.environments)),
  };
  return service;
}
export type AppStoreService = ReturnType<typeof createAppStoreService>;

export function startAppStoreMaintenance(service: Pick<AppStoreService, "maintain" | "event">, everyMs = 60_000) {
  let stopped = false;
  let running: Promise<void> | null = null;
  const tick = () => {
    if (stopped || running) return;
    running = service.maintain(() => stopped).catch(error => service.event("MaintenanceFailed", asAppStoreError(error).code)).finally(() => { running = null; });
  };
  const timer = setInterval(tick, everyMs);
  tick();
  return { async stopAndDrain() { stopped = true; clearInterval(timer); await running; } };
}
