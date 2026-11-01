import { createPrivateKey, X509Certificate } from "node:crypto";
import {
  APIException, AppStoreServerAPIClient, Environment, SignedDataVerifier,
  VerificationException, VerificationStatus,
  type JWSTransactionDecodedPayload,
} from "@apple/app-store-server-library";
import { DAY, environment, normalizeToken, transactionId } from "./core";
import { AppStoreError } from "./errors";
import { concurrencyGate } from "./concurrency";
import { appleRequest } from "./transport";
import type { AppleGateway, AppStoreEnvironment, AppStoreEvent, AppStoreStore, ProductMapping, SubscriptionKey, VerifiedSubscription, VerifiedTransaction } from "./types";

export type AppleConfiguration = {
  bundleId: string; appAppleId?: number; issuerId: string; keyId: string;
  privateKey: string; rootCertificates: Buffer[];
};
type Options = { apple: AppleConfiguration; environments: readonly AppStoreEnvironment[]; products: readonly ProductMapping[]; store: AppStoreStore; onEvent?: (event: AppStoreEvent) => void };
const urls: Record<AppStoreEnvironment, string> = { Production: "https://api.storekit.apple.com", Sandbox: "https://api.storekit-sandbox.apple.com" };
const MAX_JWS = 64 * 1024;
const sleep = (delay: number) => new Promise<void>(resolve => setTimeout(resolve, delay));

function networkFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return ["FetchError", "AbortError", "TimeoutError"].includes(error.name) || (error.cause !== undefined && networkFailure(error.cause));
}
export function appleError(error: unknown): AppStoreError {
  if (error instanceof AppStoreError) return error;
  if (networkFailure(error)) return new AppStoreError("VERIFICATION_UNAVAILABLE", { cause: error, verificationStatus: error instanceof VerificationException ? error.status : undefined });
  if (error instanceof VerificationException) {
    return new AppStoreError(error.status === VerificationStatus.RETRYABLE_VERIFICATION_FAILURE ? "VERIFICATION_UNAVAILABLE" : "INVALID_SIGNED_DATA", { cause: error, verificationStatus: error.status });
  }
  if (error instanceof APIException) {
    const code = error.apiError;
    const retryable = error.httpStatusCode >= 500 || error.httpStatusCode === 429 || [4040002, 4040004, 4040006].includes(code ?? 0);
    return new AppStoreError(code === 4000185 ? "UNSUPPORTED_PURCHASE" : "VERIFICATION_UNAVAILABLE", { cause: error, appleCode: code ?? undefined, appleHttpStatus: error.httpStatusCode, retryable });
  }
  return new AppStoreError("VERIFICATION_UNAVAILABLE", { cause: error });
}
function untrustedPayload(signed: string): Record<string, unknown> {
  if (typeof signed !== "string" || Buffer.byteLength(signed) > MAX_JWS || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(signed)) throw new AppStoreError("INVALID_SIGNED_DATA");
  try {
    const payload: unknown = JSON.parse(Buffer.from(signed.split(".")[1]!, "base64url").toString("utf8"));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error();
    return payload as Record<string, unknown>;
  } catch { throw new AppStoreError("INVALID_SIGNED_DATA"); }
}
const timestamp = (value: unknown): number | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 8.64e15) throw new AppStoreError("INVALID_SIGNED_DATA");
  return value;
};

/** Only the HTTP transport is overridden; Apple's SDK still signs and validates API messages. */
class BoundedClient extends AppStoreServerAPIClient {
  constructor(private readonly options: Options, private readonly env: AppStoreEnvironment, private readonly admit: ReturnType<typeof concurrencyGate>) {
    const { apple } = options;
    super(apple.privateKey, apple.keyId, apple.issuerId, apple.bundleId, env as Environment);
  }
  protected override async makeFetchRequest(path: string, query: URLSearchParams, method: string, body: string | Buffer | undefined, headers: Record<string, string>) {
    return this.admit(() => this.request(path, query, method, body, headers));
  }
  private async request(path: string, query: URLSearchParams, method: string, body: string | Buffer | undefined, headers: Record<string, string>) {
    const delay = await this.options.store.reserveAppleCall(this.env);
    if (delay) await sleep(delay);
    this.options.onEvent?.({ name: "AppleApiRequested", environment: this.env });
    return appleRequest(`${urls[this.env]}${path}?${query}`, { method, body, headers }, async until => {
        await this.options.store.deferAppleCalls(this.env, until);
        this.options.onEvent?.({ name: "AppleRateLimited", environment: this.env });
    });
  }
}

export function createAppleGateway(options: Options): AppleGateway {
  const { apple, environments, products } = options;
  if (!environments.length || new Set(environments).size !== environments.length) throw new Error("At least one distinct App Store environment is required");
  const admitRequest = concurrencyGate(4);
  const admitVerification = concurrencyGate(8);
  if (!apple.bundleId || !apple.keyId || !apple.issuerId || !apple.rootCertificates.length) throw new Error("Incomplete App Store configuration");
  if (environments.includes("Production") && (!Number.isSafeInteger(apple.appAppleId) || apple.appAppleId! <= 0)) throw new Error("Production requires a positive App Apple ID");
  const key = createPrivateKey(apple.privateKey);
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error("App Store signing key must be an ES256 private key");
  for (const root of apple.rootCertificates) if (!new X509Certificate(root).ca) throw new Error("App Store root certificate is not a CA");
  const mappings = new Map(products.map(product => [product.productId, product]));
  if (!mappings.size || mappings.size !== products.length || products.some(p => !p.productId || !p.entitlement || !/^[1-9][0-9]*$/.test(p.subscriptionGroupId))) throw new Error("Invalid App Store product mapping");
  const clients = new Map<AppStoreEnvironment, BoundedClient>();
  const verifiers = new Map<AppStoreEnvironment, SignedDataVerifier>();
  const historicalVerifiers = new Map<AppStoreEnvironment, SignedDataVerifier>();
  for (const env of environments) {
    environment(env, ["Production", "Sandbox"]);
    clients.set(env, new BoundedClient(options, env, admitRequest));
    verifiers.set(env, new SignedDataVerifier(apple.rootCertificates, true, env as Environment, apple.bundleId, apple.appAppleId));
    // Only authenticated API history or previously verified durable inbox records use signed-date validation.
    historicalVerifiers.set(env, new SignedDataVerifier(apple.rootCertificates, false, env as Environment, apple.bundleId, apple.appAppleId));
  }
  const verifier = (env: AppStoreEnvironment, historical: boolean) => (historical ? historicalVerifiers : verifiers).get(env)!;
  const client = (key: Pick<SubscriptionKey, "environment">) => {
    environment(key.environment, environments);
    return clients.get(key.environment)!;
  };
  const checked = async <T>(run: () => Promise<T>): Promise<T> => {
    try { return await run(); } catch (error) {
      const failure = appleError(error);
      options.onEvent?.({ name: "AppleVerificationFailed", code: failure.code, appleCode: failure.appleCode, appleHttpStatus: failure.appleHttpStatus, verificationStatus: failure.verificationStatus });
      throw failure;
    }
  };
  function decodeTransaction(payload: JWSTransactionDecodedPayload): VerifiedTransaction {
    const env = environment(payload.environment, environments);
    const mapping = payload.productId ? mappings.get(payload.productId) : undefined;
    if (payload.bundleId !== apple.bundleId || !mapping || payload.subscriptionGroupIdentifier !== mapping.subscriptionGroupId || payload.type !== "Auto-Renewable Subscription" || payload.inAppOwnershipType !== "PURCHASED") throw new AppStoreError("UNSUPPORTED_PURCHASE");
    return {
      bundleId: apple.bundleId, environment: env,
      originalTransactionId: transactionId(payload.originalTransactionId), transactionId: transactionId(payload.transactionId),
      productId: mapping.productId, subscriptionGroupId: mapping.subscriptionGroupId,
      appAccountToken: payload.appAccountToken === undefined ? null : normalizeToken(payload.appAccountToken),
      expiresAt: timestamp(payload.expiresDate), revokedAt: timestamp(payload.revocationDate), isUpgraded: payload.isUpgraded === true,
    };
  }
  const gateway: AppleGateway = {
    transaction(signed, historical = false) {
      return checked(async () => {
        const env = environment(untrustedPayload(signed).environment, environments);
        return decodeTransaction(await admitVerification(() => verifier(env, historical).verifyAndDecodeTransaction(signed)));
      });
    },
    notification(signed, historical = false) {
      return checked(async () => {
        const hint = untrustedPayload(signed);
        const appData = [hint.data, hint.summary, hint.appData].find(value => value && typeof value === "object") as { environment?: unknown } | undefined;
        const candidates = appData?.environment !== undefined ? [environment(appData.environment, environments)] : [...environments];
        let last: unknown;
        for (const env of candidates) {
          try {
            const payload = await admitVerification(() => verifier(env, historical).verifyAndDecodeNotification(signed));
            if (!payload.notificationUUID || !payload.notificationType) throw new AppStoreError("INVALID_SIGNED_DATA");
            return {
              uuid: normalizeToken(payload.notificationUUID), environment: env, type: payload.notificationType,
              subtype: payload.subtype ?? null, signedTransaction: payload.data?.signedTransactionInfo ?? null,
              signedRenewal: payload.data?.signedRenewalInfo ?? null,
            };
          } catch (error) {
            if (!(error instanceof VerificationException) || ![VerificationStatus.INVALID_APP_IDENTIFIER, VerificationStatus.INVALID_ENVIRONMENT].includes(error.status)) throw error;
            last = error;
          }
        }
        throw last ?? new AppStoreError("INVALID_SIGNED_DATA");
      });
    },
    renewal(signed, env, originalId, historical = false) {
      return checked(async () => {
        environment(env, environments);
        const payload = await admitVerification(() => verifier(env, historical).verifyAndDecodeRenewalInfo(signed));
        if (payload.originalTransactionId !== originalId) throw new AppStoreError("INVALID_SIGNED_DATA");
      });
    },
    current(key) {
      return checked(async () => {
        if (key.bundleId !== apple.bundleId) throw new AppStoreError("INVALID_SIGNED_DATA");
        const result = await client(key).getAllSubscriptionStatuses(transactionId(key.originalTransactionId));
        if (result.bundleId !== apple.bundleId || result.environment !== key.environment) throw new AppStoreError("INVALID_SIGNED_DATA");
        const candidates = (result.data ?? []).flatMap(group => (group.lastTransactions ?? []).map(item => ({ group, item }))).filter(({ item }) => item.originalTransactionId === key.originalTransactionId);
        if (candidates.length !== 1) throw new AppStoreError("VERIFICATION_UNAVAILABLE");
        const { group, item } = candidates[0]!;
        if (!item.signedTransactionInfo || !item.signedRenewalInfo || typeof item.status !== "number") throw new AppStoreError("INVALID_SIGNED_DATA");
        const transaction = await gateway.transaction(item.signedTransactionInfo);
        const renewal = await admitVerification(() => verifier(key.environment, false).verifyAndDecodeRenewalInfo(item.signedRenewalInfo!));
        if (transaction.environment !== key.environment || transaction.originalTransactionId !== key.originalTransactionId || renewal.originalTransactionId !== key.originalTransactionId || group.subscriptionGroupIdentifier !== transaction.subscriptionGroupId) throw new AppStoreError("INVALID_SIGNED_DATA");
        const state: VerifiedSubscription = {
          ...transaction, status: item.status, graceExpiresAt: timestamp(renewal.gracePeriodExpiresDate),
          autoRenew: renewal.autoRenewStatus === 1, entitlement: mappings.get(transaction.productId)!.entitlement,
        };
        return state;
      });
    },
    setToken(key, token) {
      return checked(async () => { await client(key).setAppAccountToken(transactionId(key.originalTransactionId), { appAccountToken: normalizeToken(token) }); });
    },
    history(lease) {
      return checked(async () => {
        const now = Date.now(), start = lease.windowStart.getTime(), end = lease.windowEnd.getTime();
        if (start < now - (lease.environment === "Production" ? 180 : 30) * DAY || start >= end || end > now) throw new AppStoreError("INVALID_SIGNED_DATA");
        const result = await client(lease).getNotificationHistory(lease.paginationToken, { startDate: start, endDate: end, onlyFailures: false });
        if (result.hasMore && !result.paginationToken) throw new AppStoreError("VERIFICATION_UNAVAILABLE");
        const signedPayloads = (result.notificationHistory ?? []).map(item => {
          if (!item.signedPayload) throw new AppStoreError("INVALID_SIGNED_DATA");
          return item.signedPayload;
        });
        return { signedPayloads, paginationToken: result.hasMore ? result.paginationToken! : null };
      });
    },
    testNotification(env) {
      return checked(async () => {
        const response = await client({ environment: env }).requestTestNotification();
        if (!response.testNotificationToken) throw new AppStoreError("VERIFICATION_UNAVAILABLE");
        return response.testNotificationToken;
      });
    },
  };
  return gateway;
}
