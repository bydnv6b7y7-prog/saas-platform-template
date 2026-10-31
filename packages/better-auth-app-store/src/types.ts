export type AppStoreEnvironment = "Production" | "Sandbox";
export type ProductMapping = { productId: string; subscriptionGroupId: string; entitlement: string };
export type SubscriptionKey = { bundleId: string; environment: AppStoreEnvironment; originalTransactionId: string };

/** Millisecond timestamps from verified Apple data, never client-supplied entitlements. */
export type VerifiedTransaction = SubscriptionKey & {
  transactionId: string;
  productId: string;
  subscriptionGroupId: string;
  appAccountToken: string | null;
  expiresAt: number | null;
  revokedAt: number | null;
  isUpgraded: boolean;
};
export type VerifiedSubscription = VerifiedTransaction & {
  status: number;
  graceExpiresAt: number | null;
  autoRenew: boolean;
  entitlement: string;
};
export type VerifiedNotification = {
  uuid: string;
  environment: AppStoreEnvironment;
  type: string;
  subtype: string | null;
  signedTransaction: string | null;
  signedRenewal: string | null;
};
export type AppStoreStatus = {
  environment: AppStoreEnvironment;
  asOf: string;
  entitlements: Array<{
    key: string;
    active: boolean;
    validUntil: string | null;
    lastVerifiedAt: string | null;
    stale: boolean;
  }>;
};
export type AppStoreSyncResult = {
  binding: "bound";
  tokenSyncState: "synced" | "pending" | "blocked";
  status: AppStoreStatus;
};

export type AccountRecord = { id: string; bundleId: string; userId: string | null; appAccountToken: string };
export type TokenSyncState = "none" | "pending" | "writing" | "verify_pending" | "synced" | "blocked" | "not_applicable";
export type TokenJob = {
  mode: "backfill" | "transfer";
  expectedToken: string | null;
  targetToken: string;
  ownershipVersion: number;
  auditId: string | null;
};
export type SubscriptionRecord = SubscriptionKey & {
  id: string;
  userId: string | null;
  claimedAt: Date | null;
  ownershipVersion: number;
  snapshot: VerifiedSubscription | null;
  lastVerifiedAt: Date | null;
  verificationFailedAt: Date | null;
  version: number;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  nextReconcileAt: Date;
  reconcileAttempts: number;
  tokenJob: TokenJob | null;
  tokenSyncState: TokenSyncState;
  tokenSyncAttempts: number;
  tokenSyncNextAttemptAt: Date | null;
};
export type SubscriptionLease = { record: SubscriptionRecord; owner: string; version: number; now: Date };
export type NotificationRecord = {
  id: string;
  bundleId: string;
  environment: AppStoreEnvironment;
  notificationUuid: string;
  signedPayload: string | null;
  status: "pending" | "processing" | "done" | "ignored" | "dead";
  attempts: number;
  leaseOwner: string | null;
};
export type NotificationLease = NotificationRecord & { leaseOwner: string };
export type HistoryLease = {
  environment: AppStoreEnvironment;
  owner: string;
  windowStart: Date;
  windowEnd: Date;
  paginationToken: string | null;
};
export type OwnershipAudit = {
  id: string;
  ownershipVersion: number;
  toUserId: string;
  expectedToken: string | null;
  targetToken: string;
};

export interface AppStoreStore {
  assertSchema(): Promise<void>;
  account(userId: string): Promise<AccountRecord>;
  accountByToken(token: string): Promise<AccountRecord | null>;
  subscription(key: SubscriptionKey): Promise<SubscriptionRecord | null>;
  subscriptions(userId: string, environment: AppStoreEnvironment): Promise<SubscriptionRecord[]>;
  acquire(key: SubscriptionKey): Promise<SubscriptionLease | null>;
  release(lease: SubscriptionLease): Promise<void>;
  commit(lease: SubscriptionLease, snapshot: VerifiedSubscription, userId: string | null, job: TokenJob | null, notification?: NotificationLease): Promise<SubscriptionRecord>;
  fail(lease: SubscriptionLease, errorCode: string, retryable?: boolean): Promise<void>;
  dueSubscriptions(limit: number): Promise<SubscriptionKey[]>;
  dueTokens(limit: number): Promise<SubscriptionKey[]>;
  tokenState(lease: SubscriptionLease, state: TokenSyncState, errorCode?: string): Promise<void>;
  audit(record: SubscriptionRecord): Promise<OwnershipAudit | null>;
  transfer(lease: SubscriptionLease, input: { toUserId: string; operatorUserId: string; reason: string; expectedToken: string | null; targetToken: string }): Promise<SubscriptionRecord>;
  acceptNotification(notification: VerifiedNotification, signedPayload: string): Promise<void>;
  nextNotification(): Promise<NotificationLease | null>;
  finishNotification(lease: NotificationLease, status: "done" | "ignored" | "dead", errorCode?: string): Promise<void>;
  failNotification(lease: NotificationLease, errorCode: string, retryable: boolean): Promise<void>;
  acquireHistory(environment: AppStoreEnvironment): Promise<HistoryLease | null>;
  commitHistory(lease: HistoryLease, notifications: Array<{ notification: VerifiedNotification; signedPayload: string }>, paginationToken: string | null): Promise<void>;
  failHistory(lease: HistoryLease, resetPage: boolean, retryable?: boolean): Promise<void>;
  reserveAppleCall(environment: AppStoreEnvironment): Promise<number>;
  deferAppleCalls(environment: AppStoreEnvironment, until: Date): Promise<void>;
  metrics(): Promise<{ pendingNotifications: number; oldestNotificationAgeSeconds: number; deadNotifications: number; pendingTokens: number; blockedTokens: number; staleSubscriptions: number; historyCoverageGaps: number; unfinishedHistoryScopes: number; historyLagSeconds: number }>;
  cleanup(): Promise<void>;
}

export interface AppleGateway {
  transaction(signed: string, historical?: boolean): Promise<VerifiedTransaction>;
  notification(signed: string, historical?: boolean): Promise<VerifiedNotification>;
  renewal(signed: string, environment: AppStoreEnvironment, originalTransactionId: string, historical?: boolean): Promise<void>;
  current(key: SubscriptionKey): Promise<VerifiedSubscription>;
  setToken(key: SubscriptionKey, token: string): Promise<void>;
  history(lease: HistoryLease): Promise<{ signedPayloads: string[]; paginationToken: string | null }>;
  testNotification(environment: AppStoreEnvironment): Promise<string>;
}

export type AppStoreEvent = { name: string; code?: string; environment?: AppStoreEnvironment; appleCode?: number; appleHttpStatus?: number; verificationStatus?: number };
export type AppStoreServiceOptions = {
  bundleId: string;
  environments: readonly AppStoreEnvironment[];
  store: AppStoreStore;
  gateway: AppleGateway;
  reverifyIntervalMs?: number;
  reconcileIntervalMs?: number;
  onEvent?: (event: AppStoreEvent) => void;
};
