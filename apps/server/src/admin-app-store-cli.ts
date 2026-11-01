import { adminAccess } from "@northwind/auth/admin";
import { appStoreBilling } from "@northwind/auth/app-store";
import { closeDb, db, eq, sql, and, or } from "@northwind/db";
import { user } from "@northwind/db/schema/auth";
import { iapSubscription } from "@northwind/db/schema/iap";
import { environment, normalizeToken, transactionId } from "@northwind/better-auth-app-store/core";
import { logInfo, logError } from "./logging";
import { parseAppStoreAdminCommand } from "./app-store-admin-command";

let input: ReturnType<typeof parseAppStoreAdminCommand> | undefined;
try {
  input = parseAppStoreAdminCommand(process.argv.slice(2));
  const { command, values } = input;
  if (!appStoreBilling.service || !appStoreBilling.store || !appStoreBilling.bundleId) throw new Error("App Store integration is disabled");
  const operatorId = values.operator!;
  const [operator] = await db.select({ id: user.id, role: user.role, banned: user.banned }).from(user).where(eq(user.id, operatorId)).limit(1);
  if (!operator || operator.banned || !adminAccess.allows(operator)) throw new Error("An existing, non-banned administrator is required");
  const env = environment(values.env, appStoreBilling.environments);
  await appStoreBilling.service.ready();
  if (command === "test-notification") {
    const token = await appStoreBilling.service.testNotification(env);
    console.log(JSON.stringify({ environment: env, testNotificationToken: token }));
  } else {
    const token = values.token ? normalizeToken(values.token) : null;
    const account = token ? await appStoreBilling.store.accountByToken(token) : null;
    const chainId = values["transaction-id"] ? transactionId(values["transaction-id"]) : null;
    const filter = chainId
      ? or(eq(iapSubscription.originalTransactionId, chainId), sql`${iapSubscription.snapshot}->>'transactionId' = ${chainId}`)
      : values["user-id"] ? eq(iapSubscription.userId, values["user-id"])
      : or(eq(iapSubscription.tokenSyncTargetToken, token!), sql`${iapSubscription.snapshot}->>'appAccountToken' = ${token}`, ...(account?.userId ? [eq(iapSubscription.userId, account.userId)] : []));
    const records = await db.select().from(iapSubscription).where(and(eq(iapSubscription.bundleId, appStoreBilling.bundleId), eq(iapSubscription.environment, env), filter)).limit(201);
    if (command === "transfer") {
      if (records.length !== 1) throw new Error("Transfer requires one known subscription");
      const toUserId = values["to-user-id"]!;
      const [target] = await db.select({ id: user.id }).from(user).where(eq(user.id, toUserId)).limit(1);
      if (!target) throw new Error("The target account does not exist");
      const transferred = await appStoreBilling.service.transfer({ bundleId: appStoreBilling.bundleId, environment: env, originalTransactionId: records[0]!.originalTransactionId }, {
        toUserId, fromUserId: values["from-user-id"], operatorUserId: operatorId, reason: values.reason ?? "",
      });
      console.log(JSON.stringify({ environment: env, originalTransactionId: records[0]!.originalTransactionId, ...transferred }));
    } else {
      console.log(JSON.stringify({ truncated: records.length > 200, tokenSuffix: token?.slice(-8), subscriptions: records.slice(0, 200).map(row => ({
        originalTransactionId: row.originalTransactionId, userId: row.userId, environment: row.environment,
        status: row.snapshot?.status ?? null, claimedAt: row.claimedAt, lastVerifiedAt: row.lastVerifiedAt,
        tokenSyncState: row.tokenSyncState, errorCode: row.lastError,
      })) }));
    }
  }
  logInfo("app_store_admin_command", { operator: operatorId, command, environment: env, transactionId: values["transaction-id"], userId: values["user-id"] ?? values["to-user-id"], result: "succeeded" });
} catch (error) {
  logError("app_store_admin_command", undefined, { operator: input?.values.operator, command: input?.command, result: "failed", reason: error instanceof Error ? error.message : "Unexpected failure" });
  process.exitCode = 1;
} finally { await closeDb(); }
