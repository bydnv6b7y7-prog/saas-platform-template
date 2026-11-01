export const ERROR_MESSAGES = {
  UNAUTHORIZED: "Authentication required",
  INVALID_SIGNED_DATA: "Invalid App Store signed data",
  INVALID_ENVIRONMENT: "App Store environment is not enabled",
  RESTORE_REQUIRED: "Restore purchases to associate this subscription",
  SUBSCRIPTION_OWNERSHIP_CONFLICT: "This subscription belongs to another account",
  SUBSCRIPTION_OWNERSHIP_ORPHANED: "Contact support to recover this subscription",
  APP_ACCOUNT_TOKEN_UNKNOWN: "The purchase account could not be identified",
  UNSUPPORTED_PURCHASE: "This purchase is not supported",
  NO_ACTIVE_SUBSCRIPTION: "No active subscription is available to associate",
  VERIFICATION_UNAVAILABLE: "App Store verification is temporarily unavailable",
  STORAGE_UNAVAILABLE: "Subscription storage is temporarily unavailable",
  PROCESSING_BUSY: "This subscription is being processed; retry shortly",
  TOKEN_TRANSFER_BLOCKED: "Token transfer requires support review",
} as const;
export type AppStoreErrorCode = keyof typeof ERROR_MESSAGES;
const statusByCode: Record<AppStoreErrorCode, number> = {
  UNAUTHORIZED: 401, INVALID_SIGNED_DATA: 400, INVALID_ENVIRONMENT: 400,
  RESTORE_REQUIRED: 409, SUBSCRIPTION_OWNERSHIP_CONFLICT: 409,
  SUBSCRIPTION_OWNERSHIP_ORPHANED: 409, APP_ACCOUNT_TOKEN_UNKNOWN: 409,
  UNSUPPORTED_PURCHASE: 422, NO_ACTIVE_SUBSCRIPTION: 422,
  VERIFICATION_UNAVAILABLE: 503, STORAGE_UNAVAILABLE: 503, PROCESSING_BUSY: 503,
  TOKEN_TRANSFER_BLOCKED: 409,
};
export class AppStoreError extends Error {
  readonly status: number;
  constructor(readonly code: AppStoreErrorCode, options?: { cause?: unknown; appleCode?: number; appleHttpStatus?: number; verificationStatus?: number; retryable?: boolean }) {
    super(ERROR_MESSAGES[code], { cause: options?.cause });
    this.status = statusByCode[code];
    this.appleCode = options?.appleCode;
    this.appleHttpStatus = options?.appleHttpStatus;
    this.verificationStatus = options?.verificationStatus;
    this.retryableOverride = options?.retryable;
  }
  readonly appleCode?: number;
  readonly appleHttpStatus?: number;
  readonly verificationStatus?: number;
  private readonly retryableOverride?: boolean;
  get retryable() { return this.retryableOverride ?? this.status >= 500; }
}
export function asAppStoreError(error: unknown): AppStoreError {
  return error instanceof AppStoreError ? error : new AppStoreError("STORAGE_UNAVAILABLE", { cause: error });
}
