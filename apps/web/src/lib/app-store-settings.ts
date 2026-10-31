import type { AppStoreAdminAction } from "@northwind/api/app-store-admin";
import { APP_STORE_ENVIRONMENTS } from "@northwind/env/app-store";

type Environment = AppStoreAdminAction["environment"];
export type AppStoreTestAttempt = Pick<AppStoreAdminAction, "requestId" | "environment" | "updatedAt"> & {
  status: AppStoreAdminAction["status"] | "unconfirmed" | "not_sent";
};

const RETRY_STATUSES = new Set(["unconfirmed", "not_sent", "pending", "unknown"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function appStoreTestStorageKey(bundleId: string, actorId: string, environment: Environment) {
  return `app-store-test:${encodeURIComponent(bundleId)}:${encodeURIComponent(actorId)}:${environment}`;
}

export function appStoreTestEnvironmentChoices(allowed: Environment[], attempts: Partial<Record<Environment, AppStoreTestAttempt>>) {
  return APP_STORE_ENVIRONMENTS.filter((environment) => allowed.includes(environment) || attempts[environment])
    .map((environment) => ({ environment, statusOnly: !allowed.includes(environment) }));
}

export function parseAppStoreTestAttempt(value: string | null, environment: Environment): AppStoreTestAttempt | null {
  if (!value) return null;
  try {
    const data: unknown = JSON.parse(value);
    if (!data || typeof data !== "object") return null;
    const attempt = data as Partial<AppStoreTestAttempt>;
    if (attempt.environment !== environment || typeof attempt.requestId !== "string" || !UUID.test(attempt.requestId)
      || typeof attempt.status !== "string" || !["pending", "accepted", "failed", "unknown", "unconfirmed", "not_sent"].includes(attempt.status)
      || typeof attempt.updatedAt !== "string" || !Number.isFinite(Date.parse(attempt.updatedAt))) return null;
    return { environment, requestId: attempt.requestId, status: attempt.status, updatedAt: attempt.updatedAt };
  } catch {
    return null;
  }
}

export function isUnresolvedAppStoreTest(attempt: AppStoreTestAttempt | null | undefined): boolean {
  return Boolean(attempt && RETRY_STATUSES.has(attempt.status));
}

export function canConfirmAppStoreTestWasNotSent(
  previous: AppStoreTestAttempt | null | undefined,
  rejectionCode: string | undefined,
): boolean {
  // A rejected retry cannot establish whether an earlier, unconfirmed request reached Apple.
  return (!previous || previous.status === "not_sent") && rejectionCode !== undefined
    && ["PRECONDITION_FAILED", "BAD_REQUEST", "TOO_MANY_REQUESTS", "UNAUTHORIZED", "FORBIDDEN"].includes(rejectionCode);
}

export function latestAppStoreTestAttempt(
  saved: AppStoreTestAttempt | null | undefined,
  observed: AppStoreAdminAction | undefined,
): AppStoreTestAttempt | null | undefined {
  if (!saved || !observed || saved.requestId !== observed.requestId || saved.environment !== observed.environment) return saved;
  // An unconfirmed local attempt uses the browser clock; any matching server record is authoritative.
  if (saved.status === "unconfirmed" || saved.status === "not_sent") return observed;
  const serverIsNewer = Date.parse(observed.updatedAt) > Date.parse(saved.updatedAt);
  const sameTime = observed.updatedAt === saved.updatedAt;
  return serverIsNewer || (sameTime && isUnresolvedAppStoreTest(saved)) ? observed : saved;
}

/** Call only from an explicit submit action, never while rendering or refreshing. */
export function nextAppStoreTestRequest(
  previous: AppStoreTestAttempt | null | undefined,
  environment: Environment,
  createRequestId: () => string,
): { environment: Environment; requestId: string } {
  return {
    environment,
    requestId: previous?.environment === environment && isUnresolvedAppStoreTest(previous)
      ? previous.requestId : createRequestId(),
  };
}

export function appStoreTestStatusMessage(status: AppStoreTestAttempt["status"]): string {
  switch (status) {
    case "accepted": return "Apple accepted this test request. Delivery is not confirmed; check received notifications below.";
    case "failed": return "Apple did not accept this test request. Check the request history before sending another test.";
    case "pending": return "This request is still being processed. Check its status without sending another test.";
    case "unknown": return "Apple's response could not be confirmed. This request will not be sent again; check received notifications and request history.";
    case "unconfirmed": return "The request result could not be confirmed. Retry with the same request ID to avoid sending a duplicate test.";
    case "not_sent": return "This attempt was blocked before a request was sent to Apple. Resolve the issue below, then retry.";
  }
}

export function formatAppStoreDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} sec`;
  if (seconds < 3_600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 86_400) return `${Math.round(seconds / 3_600)} hr`;
  return `${Math.round(seconds / 86_400)} days`;
}
