import { getTableColumns, sql, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { getTableConfig, type AnyPgColumn, type PgTable } from "drizzle-orm/pg-core";
import { DAY, DEFAULT_RECONCILE_INTERVAL, LEASE_MS, nextReconcileAt, normalizeToken, retryAt } from "./core";
import { AppStoreError } from "./errors";
import type {
  AccountRecord, AppStoreEnvironment, AppStoreStore, HistoryLease, NotificationLease,
  OwnershipAudit, SubscriptionKey, SubscriptionLease, SubscriptionRecord, TokenJob,
  TokenSyncState, VerifiedNotification,
} from "./types";

type Columns<K extends string> = PgTable & Record<K, AnyPgColumn>;
type DbSubscription = Omit<SubscriptionRecord, "tokenJob"> & {
  tokenSyncMode: TokenJob["mode"] | null;
  tokenSyncExpectedToken: string | null;
  tokenSyncTargetToken: string | null;
  tokenSyncOwnershipVersion: number | null;
  tokenSyncAuditId: string | null;
};
export type AppStoreTables = {
  account: Columns<keyof AccountRecord>;
  subscription: Columns<keyof DbSubscription | "lastError">;
  notification: Columns<"id" | "bundleId" | "environment" | "notificationUuid" | "type" | "subtype" | "signedPayload" | "receivedAt" | "processedAt" | "status" | "attempts" | "nextAttemptAt" | "leaseOwner" | "leaseExpiresAt" | "errorCode">;
  syncState: Columns<"bundleId" | "environment" | "windowStart" | "windowEnd" | "paginationToken" | "completedThrough" | "coverageGapAt" | "nextRunAt" | "leaseOwner" | "leaseExpiresAt" | "appleNextRequestAt" | "appleBackoffUntil">;
  audit: Columns<keyof OwnershipAudit | "bundleId" | "environment" | "originalTransactionId" | "fromUserId" | "operatorUserId" | "reason" | "createdAt">;
};
type Executor = Pick<NodePgDatabase, "execute">;
type Database = Executor & { transaction<T>(work: (tx: Executor) => Promise<T>): Promise<T> };
type Options = { db: Database; tables: AppStoreTables; bundleId: string; environments: readonly AppStoreEnvironment[]; reconcileIntervalMs?: number };
const fields = (table: PgTable) => sql.join(Object.entries(getTableColumns(table)).map(([key, col]) => sql`${col} AS ${sql.identifier(key)}`), sql`, `);
async function rows<T extends Record<string, unknown>>(db: Executor, query: SQL): Promise<T[]> {
  const result = await db.execute<Record<string, unknown>>(query);
  // Drizzle's raw execute intentionally returns timestamp strings. Decode by PostgreSQL
  // type metadata so aliases and database clock values use the same Date contract.
  const dates = new Set(result.fields.filter(field => field.dataTypeID === 1184).map(field => field.name));
  return result.rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
    dates.has(key) && typeof value === "string" ? new Date(value) : value,
  ])) as T);
}
function record(row: DbSubscription): SubscriptionRecord {
  return {
    ...row,
    tokenJob: row.tokenSyncMode && row.tokenSyncTargetToken && row.tokenSyncOwnershipVersion !== null ? {
      mode: row.tokenSyncMode, expectedToken: row.tokenSyncExpectedToken, targetToken: row.tokenSyncTargetToken,
      ownershipVersion: row.tokenSyncOwnershipVersion, auditId: row.tokenSyncAuditId,
    } : null,
  };
}
const checkedLimit = (value: number) => Math.max(1, Math.min(200, Math.trunc(value)));

export function createAppStoreDrizzleStore(options: Options): AppStoreStore {
  const { db, tables: t, bundleId, environments } = options;
  const interval = options.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL;
  const a = t.account, s = t.subscription, n = t.notification, h = t.syncState, audit = t.audit;
  const scope = (table: { bundleId: AnyPgColumn; environment: AnyPgColumn }) => sql`${table.bundleId} = ${bundleId} AND ${table.environment} IN (${sql.join(environments.map(e => sql`${e}`), sql`, `)})`;
  const keyWhere = (key: SubscriptionKey) => {
    if (key.bundleId !== bundleId || !environments.includes(key.environment)) throw new AppStoreError("INVALID_ENVIRONMENT");
    return sql`${s.bundleId} = ${bundleId} AND ${s.environment} = ${key.environment} AND ${s.originalTransactionId} = ${key.originalTransactionId}`;
  };
  const guard = (lease: SubscriptionLease) => sql`${s.id} = ${lease.record.id} AND ${s.leaseOwner} = ${lease.owner} AND ${s.version} = ${lease.version} AND ${s.leaseExpiresAt} > clock_timestamp()`;
  const ownershipGuard = (lease: SubscriptionLease) => sql`${s.ownershipVersion} = ${lease.record.ownershipVersion} AND ${s.userId} IS NOT DISTINCT FROM ${lease.record.userId}`;
  const notificationGuard = (lease: NotificationLease) => sql`${n.id} = ${lease.id} AND ${n.leaseOwner} = ${lease.leaseOwner} AND ${n.leaseExpiresAt} > clock_timestamp()`;
  const historyGuard = (lease: HistoryLease) => sql`${h.bundleId} = ${bundleId} AND ${h.environment} = ${lease.environment} AND ${h.leaseOwner} = ${lease.owner} AND ${h.leaseExpiresAt} > clock_timestamp()`;
  const changed = <T>(values: T[]): T => {
    if (!values[0]) throw new AppStoreError("PROCESSING_BUSY");
    return values[0];
  };
  const jobSet = (job: TokenJob) => sql`
    token_sync_mode = ${job.mode}, token_sync_expected_token = ${job.expectedToken},
    token_sync_target_token = ${job.targetToken}, token_sync_ownership_version = ${job.ownershipVersion},
    token_sync_audit_id = ${job.auditId}, token_sync_state = 'pending', token_sync_attempts = 0,
    token_sync_next_attempt_at = clock_timestamp()`;
  const insertNotification = (item: VerifiedNotification, signedPayload: string) => sql`
    INSERT INTO ${n} (id, bundle_id, environment, notification_uuid, type, subtype, signed_payload)
    VALUES (${crypto.randomUUID()}, ${bundleId}, ${item.environment}, ${normalizeToken(item.uuid)}, ${item.type}, ${item.subtype}, ${signedPayload})
    ON CONFLICT (bundle_id, environment, notification_uuid) DO NOTHING`;
  const ensureHistory = async (env: AppStoreEnvironment) => {
    if (!environments.includes(env)) throw new AppStoreError("INVALID_ENVIRONMENT");
    await db.execute(sql`INSERT INTO ${h} (bundle_id, environment) VALUES (${bundleId}, ${env}) ON CONFLICT DO NOTHING`);
  };

  const store: AppStoreStore = {
    async assertSchema() {
      // Compare the injected DDL with the database, not a second Better Auth schema.
      for (const table of Object.values(t)) {
        const config = getTableConfig(table);
        const actual = await rows<{ column_name: string; udt_name: string; is_nullable: string }>(db, sql`
          SELECT column_name, udt_name, is_nullable FROM information_schema.columns
          WHERE table_schema = ${config.schema ?? "public"} AND table_name = ${config.name}`);
        const columns = new Map(actual.map(c => [c.column_name, c]));
        for (const col of config.columns) {
          const column = columns.get(col.name);
          if (!column || (col.notNull && column.is_nullable !== "NO") || (col.getSQLType() === "uuid" && column.udt_name !== "uuid")) {
            throw new Error(`App Store migration missing or incompatible: ${config.name}.${col.name}`);
          }
        }
        const indices = await rows<{ name: string; unique: boolean; valid: boolean; columns: string[] }>(db, sql`
          SELECT ic.relname AS name, i.indisunique AS unique, i.indisvalid AS valid,
            ARRAY(SELECT att.attname::text FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
              JOIN pg_attribute att ON att.attrelid = tc.oid AND att.attnum = k.attnum ORDER BY k.ord) AS columns
          FROM pg_index i JOIN pg_class tc ON tc.oid = i.indrelid JOIN pg_namespace ns ON ns.oid = tc.relnamespace
            JOIN pg_class ic ON ic.oid = i.indexrelid
          WHERE ns.nspname = ${config.schema ?? "public"} AND tc.relname = ${config.name}`);
        const names = new Map(indices.map(i => [i.name, i]));
        for (const index of config.indexes) {
          const actualIndex = index.config.name ? names.get(index.config.name) : undefined;
          const expectedColumns = index.config.columns.map(col => "name" in col ? col.name : null);
          if (!actualIndex?.valid || actualIndex.unique !== index.config.unique || JSON.stringify(actualIndex.columns) !== JSON.stringify(expectedColumns)) throw new Error(`App Store index missing or incompatible: ${index.config.name}`);
        }
        const constraints = await rows<{ name: string; valid: boolean; deletion: string }>(db, sql`
          SELECT c.conname AS name, c.convalidated AS valid, c.confdeltype AS deletion FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace ns ON ns.oid = t.relnamespace
          WHERE ns.nspname = ${config.schema ?? "public"} AND t.relname = ${config.name} AND c.contype = 'f'`);
        for (const fk of config.foreignKeys) {
          const constraint = constraints.find(c => c.name === fk.getName());
          if (!constraint?.valid || (fk.onDelete === "set null" && constraint.deletion !== "n")) throw new Error(`App Store foreign key missing or incompatible: ${fk.getName()}`);
        }
      }
    },
    async account(userId) {
      const values = await rows<AccountRecord>(db, sql`
        INSERT INTO ${a} (id, bundle_id, user_id, app_account_token)
        VALUES (${crypto.randomUUID()}, ${bundleId}, ${userId}, ${crypto.randomUUID()})
        ON CONFLICT (bundle_id, user_id) DO UPDATE SET user_id = EXCLUDED.user_id
        RETURNING ${fields(a)}`);
      return changed(values);
    },
    async accountByToken(token) {
      return (await rows<AccountRecord>(db, sql`SELECT ${fields(a)} FROM ${a} WHERE ${a.bundleId} = ${bundleId} AND ${a.appAccountToken} = ${normalizeToken(token)} LIMIT 1`))[0] ?? null;
    },
    async subscription(key) {
      const value = (await rows<DbSubscription>(db, sql`SELECT ${fields(s)} FROM ${s} WHERE ${keyWhere(key)}`))[0];
      return value ? record(value) : null;
    },
    async subscriptions(userId, env) {
      if (!environments.includes(env)) throw new AppStoreError("INVALID_ENVIRONMENT");
      return (await rows<DbSubscription>(db, sql`SELECT ${fields(s)} FROM ${s} WHERE ${s.bundleId} = ${bundleId} AND ${s.environment} = ${env} AND ${s.userId} = ${userId}`)).map(record);
    },
    async acquire(key) {
      keyWhere(key);
      await db.execute(sql`INSERT INTO ${s} (id, bundle_id, environment, original_transaction_id)
        VALUES (${crypto.randomUUID()}, ${bundleId}, ${key.environment}, ${key.originalTransactionId})
        ON CONFLICT (bundle_id, environment, original_transaction_id) DO NOTHING`);
      const owner = crypto.randomUUID();
      const value = (await rows<DbSubscription & { dbNow: Date }>(db, sql`
        UPDATE ${s} SET lease_owner = ${owner}, lease_expires_at = clock_timestamp() + ${LEASE_MS} * interval '1 millisecond', version = version + 1
        WHERE ${keyWhere(key)} AND (${s.leaseExpiresAt} IS NULL OR ${s.leaseExpiresAt} <= clock_timestamp())
        RETURNING ${fields(s)}, clock_timestamp() AS "dbNow"`))[0];
      return value ? { record: record(value), owner, version: value.version, now: value.dbNow } : null;
    },
    async release(lease) {
      await db.execute(sql`UPDATE ${s} SET lease_owner = NULL, lease_expires_at = NULL WHERE ${s.id} = ${lease.record.id} AND ${s.leaseOwner} = ${lease.owner} AND ${s.version} = ${lease.version}`);
    },
    async commit(lease, snapshot, userId, job, notification) {
      if (lease.record.claimedAt && lease.record.userId !== userId) throw new AppStoreError("SUBSCRIPTION_OWNERSHIP_CONFLICT");
      keyWhere(snapshot);
      if (snapshot.originalTransactionId !== lease.record.originalTransactionId || snapshot.environment !== lease.record.environment) throw new AppStoreError("INVALID_SIGNED_DATA");
      return db.transaction(async tx => {
        const now = changed(await rows<{ now: Date }>(tx, sql`SELECT clock_timestamp() AS now`)).now;
        const firstClaim = lease.record.claimedAt === null && userId !== null;
        const result = changed(await rows<DbSubscription>(tx, sql`
          UPDATE ${s} SET snapshot = ${JSON.stringify(snapshot)}::jsonb, last_verified_at = ${now}, verification_failed_at = NULL,
          last_error = NULL, reconcile_attempts = 0, next_reconcile_at = ${nextReconcileAt(snapshot, now.getTime(), interval)},
          user_id = ${userId}, claimed_at = ${firstClaim ? now : lease.record.claimedAt},
          ownership_version = ${lease.record.ownershipVersion + (firstClaim ? 1 : 0)}
          ${job ? sql`, ${jobSet(job)}` : sql``}
          WHERE ${guard(lease)} AND ${ownershipGuard(lease)} RETURNING ${fields(s)}`));
        if (notification) changed(await rows(tx, sql`UPDATE ${n} SET status = 'done', processed_at = clock_timestamp(), error_code = NULL, lease_owner = NULL, lease_expires_at = NULL WHERE ${notificationGuard(notification)} RETURNING ${n.id}`));
        return record(result);
      });
    },
    async fail(lease, code, retryable = true) {
      await db.execute(sql`UPDATE ${s} SET verification_failed_at = clock_timestamp(), last_error = ${code}, reconcile_attempts = reconcile_attempts + 1,
        next_reconcile_at = ${retryable ? retryAt(lease.record.reconcileAttempts, Date.now()) : new Date(Date.now() + interval)}
        WHERE ${guard(lease)} AND ${ownershipGuard(lease)}`);
    },
    async dueSubscriptions(limit) {
      return rows<SubscriptionKey>(db, sql`SELECT ${s.bundleId} AS "bundleId", ${s.environment} AS environment, ${s.originalTransactionId} AS "originalTransactionId" FROM ${s}
        WHERE ${scope(s)} AND ${s.userId} IS NOT NULL AND ${s.nextReconcileAt} <= clock_timestamp()
        AND (${s.leaseExpiresAt} IS NULL OR ${s.leaseExpiresAt} <= clock_timestamp()) ORDER BY ${s.nextReconcileAt}, ${s.id} LIMIT ${checkedLimit(limit)}`);
    },
    async dueTokens(limit) {
      return rows<SubscriptionKey>(db, sql`SELECT ${s.bundleId} AS "bundleId", ${s.environment} AS environment, ${s.originalTransactionId} AS "originalTransactionId" FROM ${s}
        WHERE ${scope(s)} AND ${s.userId} IS NOT NULL AND ${s.tokenSyncState} IN ('pending', 'writing', 'verify_pending')
        AND ${s.tokenSyncNextAttemptAt} <= clock_timestamp() AND (${s.leaseExpiresAt} IS NULL OR ${s.leaseExpiresAt} <= clock_timestamp())
        ORDER BY ${s.tokenSyncNextAttemptAt}, ${s.id} LIMIT ${checkedLimit(limit)}`);
    },
    async tokenState(lease, state, errorCode) {
      const attempts = lease.record.tokenSyncAttempts + (state === "verify_pending" ? 1 : 0);
      const nextState: TokenSyncState = attempts >= 12 && state === "verify_pending" ? "blocked" : state;
      changed(await rows(db, sql`UPDATE ${s} SET token_sync_state = ${nextState}, token_sync_attempts = ${attempts}, last_error = ${errorCode ?? null},
        token_sync_next_attempt_at = ${nextState === "verify_pending" ? retryAt(attempts, Date.now()) : nextState === "writing" ? new Date(Date.now() + LEASE_MS) : nextState === "pending" ? new Date() : null}
        WHERE ${guard(lease)} AND ${ownershipGuard(lease)} AND (${nextState === "blocked"} OR ${s.tokenSyncOwnershipVersion} = ${lease.record.ownershipVersion})
        RETURNING ${s.id}`));
    },
    async audit(row) {
      if (!row.tokenJob?.auditId) return null;
      return (await rows<OwnershipAudit>(db, sql`SELECT ${fields(audit)} FROM ${audit} WHERE ${audit.id} = ${row.tokenJob.auditId}
        AND ${audit.bundleId} = ${bundleId} AND ${audit.environment} = ${row.environment} AND ${audit.originalTransactionId} = ${row.originalTransactionId}
        AND ${audit.ownershipVersion} = ${row.ownershipVersion}`))[0] ?? null;
    },
    async transfer(lease, input) {
      const id = crypto.randomUUID(), version = lease.record.ownershipVersion + 1;
      if (lease.record.userId === input.toUserId) throw new AppStoreError("TOKEN_TRANSFER_BLOCKED");
      const job: TokenJob = { mode: "transfer", expectedToken: input.expectedToken, targetToken: input.targetToken, ownershipVersion: version, auditId: id };
      return db.transaction(async tx => {
        await tx.execute(sql`INSERT INTO ${audit} (id, bundle_id, environment, original_transaction_id, from_user_id, to_user_id, ownership_version, expected_token, target_token, operator_user_id, reason)
          VALUES (${id}, ${bundleId}, ${lease.record.environment}, ${lease.record.originalTransactionId}, ${lease.record.userId}, ${input.toUserId}, ${version}, ${input.expectedToken}, ${input.targetToken}, ${input.operatorUserId}, ${input.reason})`);
        const value = changed(await rows<DbSubscription>(tx, sql`UPDATE ${s} SET user_id = ${input.toUserId}, claimed_at = COALESCE(claimed_at, clock_timestamp()), ownership_version = ${version}, ${jobSet(job)}, next_reconcile_at = clock_timestamp()
          WHERE ${guard(lease)} AND ${ownershipGuard(lease)} RETURNING ${fields(s)}`));
        return record(value);
      });
    },
    async acceptNotification(item, signedPayload) {
      if (!environments.includes(item.environment)) throw new AppStoreError("INVALID_ENVIRONMENT");
      await db.execute(insertNotification(item, signedPayload));
    },
    async nextNotification() {
      const owner = crypto.randomUUID();
      const value = (await rows<NotificationLease>(db, sql`UPDATE ${n} SET status = 'processing', lease_owner = ${owner},
        lease_expires_at = clock_timestamp() + ${LEASE_MS} * interval '1 millisecond', attempts = attempts + 1
        WHERE ${n.id} = (SELECT ${n.id} FROM ${n} WHERE ${scope(n)} AND ${n.status} IN ('pending', 'processing')
          AND ${n.nextAttemptAt} <= clock_timestamp() AND (${n.leaseExpiresAt} IS NULL OR ${n.leaseExpiresAt} <= clock_timestamp())
          ORDER BY ${n.nextAttemptAt}, ${n.id} FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING ${fields(n)}`))[0];
      return value ?? null;
    },
    async finishNotification(lease, status, code) {
      changed(await rows(db, sql`UPDATE ${n} SET status = ${status}, error_code = ${code ?? null}, processed_at = clock_timestamp(), lease_owner = NULL, lease_expires_at = NULL
        WHERE ${notificationGuard(lease)} RETURNING ${n.id}`));
    },
    async failNotification(lease, code, retryable) {
      const dead = !retryable || lease.attempts >= 12;
      await db.execute(sql`UPDATE ${n} SET status = ${dead ? "dead" : "pending"}, error_code = ${code}, next_attempt_at = ${retryAt(lease.attempts, Date.now())},
        lease_owner = NULL, lease_expires_at = NULL WHERE ${notificationGuard(lease)}`);
    },
    async acquireHistory(env) {
      await ensureHistory(env);
      const owner = crypto.randomUUID(), retention = (env === "Production" ? 180 : 30) * DAY;
      const value = (await rows<Omit<HistoryLease, "owner">>(db, sql`UPDATE ${h} SET lease_owner = ${owner}, lease_expires_at = clock_timestamp() + ${LEASE_MS} * interval '1 millisecond',
        coverage_gap_at = CASE WHEN COALESCE(window_start, completed_through) < clock_timestamp() - ${retention} * interval '1 millisecond' THEN clock_timestamp() ELSE coverage_gap_at END,
        window_start = CASE WHEN window_start >= clock_timestamp() - ${retention} * interval '1 millisecond' THEN window_start
          ELSE GREATEST(COALESCE(completed_through - interval '5 minutes', clock_timestamp() - interval '7 days'), clock_timestamp() - ${retention - DAY} * interval '1 millisecond') END,
        window_end = CASE WHEN window_end IS NULL OR window_start < clock_timestamp() - ${retention} * interval '1 millisecond' THEN clock_timestamp() ELSE window_end END,
        pagination_token = CASE WHEN window_start < clock_timestamp() - ${retention} * interval '1 millisecond' THEN NULL ELSE pagination_token END
        WHERE ${h.bundleId} = ${bundleId} AND ${h.environment} = ${env} AND ${h.nextRunAt} <= clock_timestamp()
        AND (${h.leaseExpiresAt} IS NULL OR ${h.leaseExpiresAt} <= clock_timestamp())
        RETURNING ${h.environment} AS environment, ${h.windowStart} AS "windowStart", ${h.windowEnd} AS "windowEnd", ${h.paginationToken} AS "paginationToken"`))[0];
      return value ? { ...value, owner } : null;
    },
    async commitHistory(lease, items, page) {
      await db.transaction(async tx => {
        for (const item of items) {
          if (item.notification.environment !== lease.environment) throw new AppStoreError("INVALID_ENVIRONMENT");
          await tx.execute(insertNotification(item.notification, item.signedPayload));
        }
        changed(await rows(tx, sql`UPDATE ${h} SET pagination_token = ${page}, completed_through = ${page === null ? sql`${lease.windowEnd}::timestamptz` : h.completedThrough},
          window_start = ${page === null ? null : lease.windowStart}, window_end = ${page === null ? null : lease.windowEnd},
          next_run_at = clock_timestamp() + ${page === null ? interval : 0} * interval '1 millisecond', lease_owner = NULL, lease_expires_at = NULL
          WHERE ${historyGuard(lease)} RETURNING ${h.bundleId}`));
      });
    },
    async failHistory(lease, resetPage, retryable = true) {
      await db.execute(sql`UPDATE ${h} SET pagination_token = ${resetPage ? sql`NULL` : h.paginationToken}, next_run_at = clock_timestamp() + ${retryable ? 60_000 : interval} * interval '1 millisecond', lease_owner = NULL, lease_expires_at = NULL
        WHERE ${historyGuard(lease)}`);
    },
    async reserveAppleCall(env) {
      await ensureHistory(env);
      const spacing = env === "Production" ? 100 : 1_000;
      const value = (await rows<{ delay: number }>(db, sql`UPDATE ${h} SET apple_next_request_at = GREATEST(apple_next_request_at, apple_backoff_until, clock_timestamp()) + ${spacing} * interval '1 millisecond'
        WHERE ${h.bundleId} = ${bundleId} AND ${h.environment} = ${env}
        AND GREATEST(apple_next_request_at, apple_backoff_until, clock_timestamp()) < clock_timestamp() + interval '2 seconds'
        RETURNING GREATEST(0, EXTRACT(epoch FROM (apple_next_request_at - clock_timestamp())) * 1000 - ${spacing})::int AS delay`))[0];
      if (!value) throw new AppStoreError("VERIFICATION_UNAVAILABLE", { appleCode: 4290000 });
      return value.delay;
    },
    async deferAppleCalls(env, until) {
      await ensureHistory(env);
      await db.execute(sql`UPDATE ${h} SET apple_backoff_until = GREATEST(apple_backoff_until, ${until}) WHERE ${h.bundleId} = ${bundleId} AND ${h.environment} = ${env}`);
    },
    async metrics() {
      const nv = changed(await rows<{ pending: number; dead: number; age: number }>(db, sql`SELECT count(*) FILTER (WHERE status IN ('pending','processing'))::int AS pending,
        count(*) FILTER (WHERE status = 'dead')::int AS dead,
        COALESCE(EXTRACT(epoch FROM clock_timestamp() - min(received_at) FILTER (WHERE status IN ('pending','processing'))), 0)::int AS age FROM ${n} WHERE ${scope(n)}`));
      const sv = changed(await rows<{ pending: number; blocked: number; stale: number }>(db, sql`SELECT count(*) FILTER (WHERE token_sync_state IN ('pending','writing','verify_pending'))::int AS pending,
        count(*) FILTER (WHERE token_sync_state = 'blocked')::int AS blocked,
        count(*) FILTER (WHERE user_id IS NOT NULL AND (verification_failed_at IS NOT NULL OR last_verified_at IS NULL OR last_verified_at < clock_timestamp() - ${2 * interval} * interval '1 millisecond'))::int AS stale FROM ${s} WHERE ${scope(s)}`));
      const hv = changed(await rows<{ gaps: number; unfinished: number; lag: number }>(db, sql`SELECT count(*) FILTER (WHERE coverage_gap_at IS NOT NULL)::int AS gaps,
        count(*) FILTER (WHERE completed_through IS NULL OR window_end IS NOT NULL)::int AS unfinished,
        COALESCE(GREATEST(0, EXTRACT(epoch FROM clock_timestamp() - min(COALESCE(completed_through, window_start)))), 0)::int AS lag
        FROM ${h} WHERE ${scope(h)}`));
      return { pendingNotifications: nv.pending, oldestNotificationAgeSeconds: nv.age, deadNotifications: nv.dead, pendingTokens: sv.pending, blockedTokens: sv.blocked, staleSubscriptions: sv.stale,
        historyCoverageGaps: hv.gaps, unfinishedHistoryScopes: hv.unfinished, historyLagSeconds: hv.lag };
    },
    async cleanup() {
      await db.execute(sql`UPDATE ${n} SET signed_payload = NULL WHERE ${scope(n)} AND ${n.receivedAt} < clock_timestamp() - interval '180 days' AND ${n.status} IN ('done','ignored','dead') AND ${n.signedPayload} IS NOT NULL`);
    },
  };
  return store;
}
