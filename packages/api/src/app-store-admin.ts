import { createPrivateKey } from "node:crypto";
import { createAppStoreDrizzleStore } from "@northwind/better-auth-app-store/drizzle";
import { ERROR_MESSAGES } from "@northwind/better-auth-app-store/errors";
import type { AppStoreEnvironment, AppStoreStore } from "@northwind/better-auth-app-store/types";
import { and, db, desc, eq, inArray, sql } from "@northwind/db";
import { iapAdminAction, iapNotification, iapTables } from "@northwind/db/schema/iap";
import { APPLE_APPLICATION, appleApplicationLegacyIdentitySchema } from "@northwind/env/apple-application";
import { APP_STORE_CREDENTIAL_KEYS, APP_STORE_ENVIRONMENTS, APP_STORE_MAINTENANCE_DEFAULTS, appStoreEnvironmentsSchema, appStoreMaintenanceSchema } from "@northwind/env/app-store";
import { env } from "@northwind/env/server";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

export type { AppStoreEnvironment };
const ENVIRONMENTS = APP_STORE_ENVIRONMENTS;
const CREDENTIAL_KEYS = APP_STORE_CREDENTIAL_KEYS;
const ACTION_CODES = ["APPLE_REQUEST_REJECTED", "APPLE_OUTCOME_UNKNOWN"] as const;
const NOTIFICATION_CODES = new Set([...Object.keys(ERROR_MESSAGES), "TEST", "UNSUPPORTED_NOTIFICATION"]);
const notificationStatuses = new Set(["pending", "processing", "done", "ignored", "dead"]);
type Metrics = Awaited<ReturnType<AppStoreStore["metrics"]>>;
export type AppStoreAdminAction = {
  requestId: string;
  actorId: string;
  environment: AppStoreEnvironment;
  status: "pending" | "accepted" | "failed" | "unknown";
  errorCode: typeof ACTION_CODES[number] | null;
  createdAt: string;
  updatedAt: string;
};
export type AppStoreAdminNotification = {
  id: string;
  environment: AppStoreEnvironment;
  type: string;
  status: string;
  receivedAt: string;
  processedAt: string | null;
  attempts: number;
  errorCode: string | null;
};
export type AppStoreAdminConfiguration = {
  application: typeof APPLE_APPLICATION;
  enabled: boolean;
  configured: boolean;
  credentials: Array<{ key: typeof CREDENTIAL_KEYS[number]; present: boolean }>;
  configurationError: "INVALID_CONFIGURATION" | null;
  allowedEnvironments: AppStoreEnvironment[];
  notificationUrl: string | null;
  maintenance: { reverifyIntervalSeconds: number; reconcileIntervalSeconds: number };
};
export type AppStoreAdminOverview = AppStoreAdminConfiguration & {
  diagnostics: {
    observedAt: string;
    environments: Array<{ environment: AppStoreEnvironment; processingEnabled: boolean; available: boolean; metrics: Metrics | null }>;
  };
  notifications: { available: boolean; items: AppStoreAdminNotification[] };
  audit: { available: boolean; items: AppStoreAdminAction[] };
};

/** Whitelist metadata here. Runtime credentials and errors never enter an API result. */
export function readAppStoreAdminConfiguration(values: Record<string, unknown>): AppStoreAdminConfiguration {
  const credentials = CREDENTIAL_KEYS.map(key => ({ key, present: typeof values[key] === "string" && !!values[key].trim() }));
  const environments = appStoreEnvironmentsSchema.safeParse(values.APP_STORE_ENVIRONMENTS);
  const identity = appleApplicationLegacyIdentitySchema.safeParse(values);
  const intervals = appStoreMaintenanceSchema.safeParse(values);
  let keyValid = !credentials[2]!.present;
  if (credentials[2]!.present) {
    try {
      const key = createPrivateKey(Buffer.from(values.APP_STORE_PRIVATE_KEY_BASE64 as string, "base64").toString("utf8"));
      keyValid = key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1";
    } catch { keyValid = false; }
  }
  let notificationUrl: string | null = null;
  try {
    const url = new URL(String(values.BETTER_AUTH_URL));
    if (["https:", "http:"].includes(url.protocol)) notificationUrl = `${url.origin}/api/auth/app-store/notifications`;
  } catch { /* Report an unavailable address instead of leaking the deployment value. */ }
  const valid = environments.success && identity.success && intervals.success && keyValid && notificationUrl !== null;
  return {
    application: APPLE_APPLICATION,
    enabled: values.APP_STORE_ENABLED !== false && values.APP_STORE_ENABLED !== "false",
    configured: credentials.every(credential => credential.present) && valid,
    credentials,
    configurationError: valid ? null : "INVALID_CONFIGURATION",
    allowedEnvironments: environments.success ? environments.data : [],
    notificationUrl,
    maintenance: intervals.success ? {
      reverifyIntervalSeconds: intervals.data.APP_STORE_REVERIFY_INTERVAL_SECONDS,
      reconcileIntervalSeconds: intervals.data.APP_STORE_RECONCILE_INTERVAL_SECONDS,
    } : APP_STORE_MAINTENANCE_DEFAULTS,
  };
}

export const appStoreTestNotificationInput = z.strictObject({
  environment: z.enum(ENVIRONMENTS),
  requestId: z.uuid(),
});
type TestInput = z.infer<typeof appStoreTestNotificationInput> & { actorId: string };
type Outcome = Pick<AppStoreAdminAction, "status" | "errorCode">;
export type AppStoreAdminRepository = {
  metrics(environment: AppStoreEnvironment): Promise<Metrics>;
  notifications(): Promise<AppStoreAdminNotification[]>;
  history(): Promise<AppStoreAdminAction[]>;
  testRequest(input: TestInput): Promise<AppStoreAdminAction | null>;
  reserve(input: TestInput): Promise<{ action: AppStoreAdminAction; isNew: boolean }>;
  finish(requestId: string, outcome: Outcome): Promise<AppStoreAdminAction>;
};

function action(row: typeof iapAdminAction.$inferSelect): AppStoreAdminAction {
  return {
    requestId: row.requestId, actorId: row.actorId, environment: row.environment as AppStoreEnvironment,
    status: row.status as AppStoreAdminAction["status"],
    errorCode: ACTION_CODES.includes(row.errorCode as typeof ACTION_CODES[number]) ? row.errorCode as typeof ACTION_CODES[number] : null,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  };
}

export function createAppStoreAdminRepository(
  database: typeof db,
  config: () => AppStoreAdminConfiguration,
): AppStoreAdminRepository {
  const bundleId = APPLE_APPLICATION.bundleId;
  const scope = and(eq(iapAdminAction.bundleId, bundleId), inArray(iapAdminAction.environment, [...ENVIRONMENTS]));
  async function expireAbandoned() {
    await database.update(iapAdminAction).set({ status: "unknown", errorCode: "APPLE_OUTCOME_UNKNOWN", updatedAt: sql`clock_timestamp()` })
      .where(and(scope, eq(iapAdminAction.status, "pending"), sql`${iapAdminAction.createdAt} < clock_timestamp() - interval '2 minutes'`));
  }
  return {
    metrics(environment) {
      // Inspect both supported environments, including disabled scopes. Reuse runtime metric definitions.
      return createAppStoreDrizzleStore({
        db: database, tables: iapTables, bundleId, environments: [environment],
        reconcileIntervalMs: config().maintenance.reconcileIntervalSeconds * 1_000,
      }).metrics();
    },
    async notifications() {
      const rows = await database.select({
        id: iapNotification.id, environment: iapNotification.environment, type: iapNotification.type,
        status: iapNotification.status, receivedAt: iapNotification.receivedAt, processedAt: iapNotification.processedAt,
        attempts: iapNotification.attempts, errorCode: iapNotification.errorCode,
      }).from(iapNotification).where(and(eq(iapNotification.bundleId, bundleId), inArray(iapNotification.environment, [...ENVIRONMENTS])))
        .orderBy(desc(iapNotification.receivedAt), desc(iapNotification.id)).limit(20);
      return rows.map(row => ({
        id: row.id, environment: row.environment as AppStoreEnvironment,
        type: /^[A-Z_]{1,80}$/.test(row.type) ? row.type : "UNKNOWN",
        status: notificationStatuses.has(row.status) ? row.status : "unknown",
        receivedAt: row.receivedAt.toISOString(), processedAt: row.processedAt?.toISOString() ?? null,
        attempts: row.attempts,
        errorCode: row.errorCode ? NOTIFICATION_CODES.has(row.errorCode) ? row.errorCode : "UNKNOWN_ERROR" : null,
      }));
    },
    async history() {
      await expireAbandoned();
      return (await database.select().from(iapAdminAction).where(scope)
        .orderBy(desc(iapAdminAction.createdAt), desc(iapAdminAction.requestId)).limit(20)).map(action);
    },
    async testRequest(input) {
      const requestScope = and(scope, eq(iapAdminAction.requestId, input.requestId),
        eq(iapAdminAction.environment, input.environment), eq(iapAdminAction.actorId, input.actorId));
      await database.update(iapAdminAction).set({ status: "unknown", errorCode: "APPLE_OUTCOME_UNKNOWN", updatedAt: sql`clock_timestamp()` })
        .where(and(requestScope, eq(iapAdminAction.status, "pending"), sql`${iapAdminAction.createdAt} < clock_timestamp() - interval '2 minutes'`));
      const [row] = await database.select().from(iapAdminAction).where(requestScope).limit(1);
      return row ? action(row) : null;
    },
    async reserve(input) {
      return database.transaction(async transaction => {
        // Fixed namespace is separate from operational settings. Lock covers absent rows across API instances.
        await transaction.execute(sql`select pg_advisory_xact_lock(812, 2)`);
        await transaction.update(iapAdminAction).set({ status: "unknown", errorCode: "APPLE_OUTCOME_UNKNOWN", updatedAt: sql`clock_timestamp()` })
          .where(and(scope, eq(iapAdminAction.status, "pending"), sql`${iapAdminAction.createdAt} < clock_timestamp() - interval '2 minutes'`));
        const [existing] = await transaction.select().from(iapAdminAction).where(eq(iapAdminAction.requestId, input.requestId));
        if (existing) {
          if (existing.bundleId !== bundleId || existing.environment !== input.environment || existing.actorId !== input.actorId) {
            throw new TRPCError({ code: "CONFLICT", message: "This request ID belongs to a different App Store test request." });
          }
          return { action: action(existing), isNew: false };
        }
        const [recent] = await transaction.select({ requestId: iapAdminAction.requestId }).from(iapAdminAction)
          .where(and(scope, eq(iapAdminAction.environment, input.environment), sql`${iapAdminAction.createdAt} > clock_timestamp() - interval '60 seconds'`)).limit(1);
        if (recent) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Wait 60 seconds between test requests for this environment." });
        const [created] = await transaction.insert(iapAdminAction).values({
          requestId: input.requestId, actorId: input.actorId, environment: input.environment, bundleId,
          // now() is transaction-start time, which can predate waiting for the lock.
          createdAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()`,
        }).returning();
        return { action: action(created!), isNew: true };
      });
    },
    async finish(requestId, outcome) {
      const [row] = await database.update(iapAdminAction).set({ ...outcome, updatedAt: sql`clock_timestamp()` })
        .where(and(scope, eq(iapAdminAction.requestId, requestId), inArray(iapAdminAction.status, ["pending", "unknown"]))).returning();
      if (!row) throw new Error("App Store audit request unavailable");
      return action(row);
    },
  };
}

export function createAppStoreAdminService(options: {
  configuration(): AppStoreAdminConfiguration;
  repository: AppStoreAdminRepository;
  requestTestNotification(environment: AppStoreEnvironment): Promise<unknown>;
}) {
  return {
    async overview(): Promise<AppStoreAdminOverview> {
      const configuration = options.configuration();
      const [production, sandbox, notifications, history] = await Promise.allSettled([
        options.repository.metrics("Production"), options.repository.metrics("Sandbox"),
        options.repository.notifications(), options.repository.history(),
      ]);
      return {
        ...configuration,
        diagnostics: {
          observedAt: new Date().toISOString(),
          environments: [production, sandbox].map((result, index) => ({
            environment: ENVIRONMENTS[index]!,
            processingEnabled: configuration.enabled && configuration.configured && configuration.allowedEnvironments.includes(ENVIRONMENTS[index]!),
            available: result.status === "fulfilled", metrics: result.status === "fulfilled" ? result.value : null,
          })),
        },
        notifications: { available: notifications.status === "fulfilled", items: notifications.status === "fulfilled" ? notifications.value : [] },
        audit: { available: history.status === "fulfilled", items: history.status === "fulfilled" ? history.value : [] },
      };
    },
    async testRequest(input: TestInput): Promise<AppStoreAdminAction | null> {
      // A stored result remains readable after processing or this environment is disabled.
      try { return await options.repository.testRequest(input); }
      catch {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Test request audit is unavailable. Try checking this request again later." });
      }
    },
    async testNotification(input: TestInput): Promise<AppStoreAdminAction> {
      const configuration = options.configuration();
      if (!configuration.enabled || !configuration.configured) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "App Store billing must be enabled and configured before requesting a test notification." });
      }
      if (!configuration.allowedEnvironments.includes(input.environment)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "This App Store environment is not enabled." });
      }
      let reserved: Awaited<ReturnType<AppStoreAdminRepository["reserve"]>>;
      try { reserved = await options.repository.reserve(input); }
      catch (error) {
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Test request audit is unavailable. This attempt made no new call to Apple; check this request again later." });
      }
      if (!reserved.isNew) return reserved.action;
      let outcome: Outcome;
      try {
        await options.requestTestNotification(input.environment);
        // Acceptance does not confirm delivery. The token is deliberately discarded.
        outcome = { status: "accepted", errorCode: null };
      } catch (error) {
        const status = typeof error === "object" && error !== null && "appleHttpStatus" in error ? error.appleHttpStatus : undefined;
        const rejected = typeof status === "number" && status >= 400 && status < 500 && status !== 408;
        outcome = rejected ? { status: "failed", errorCode: "APPLE_REQUEST_REJECTED" } : { status: "unknown", errorCode: "APPLE_OUTCOME_UNKNOWN" };
      }
      try { return await options.repository.finish(input.requestId, outcome); }
      catch {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "The test request outcome could not be saved. Reload its audit status; do not start a new request." });
      }
    },
  };
}

const configuration = () => readAppStoreAdminConfiguration(env);
export const appStoreAdmin = createAppStoreAdminService({
  configuration,
  repository: createAppStoreAdminRepository(db, configuration),
  async requestTestNotification(environment) {
    const { appStoreBilling } = await import("@northwind/auth/app-store");
    if (!appStoreBilling.service) throw new Error("App Store service unavailable");
    await appStoreBilling.service.testNotification(environment);
  },
});
