import { AsyncLocalStorage } from "node:async_hooks";
import { IDENTIFIER_PREFIX } from "@northwind/env/brand";

type LogLevel = "info" | "warn" | "error";
type LogFields = Record<string, unknown>;

type SafeErrorFields = {
  errorName: string;
  errorCode?: string;
};

type RequestLogState = {
  requestId: string;
  fields: LogFields;
  error?: SafeErrorFields;
};

type HttpRequestLogInput = {
  requestId: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
};

type HttpRequestLogOptions = {
  sampleRate: number;
  slowRequestMs: number;
};

const requestLogStorage = new AsyncLocalStorage<RequestLogState>();
const OPERATIONAL_PATHS = new Set([
  "/livez",
  "/readyz",
  "/version",
  "/internal/metrics",
]);
const AUDITED_WRITE_PATHS = new Set(["/api/auth/*"]);
const SENSITIVE_KEY =
  /^(?:authorization|body|cookie|headers?|password|private[-_]?key|secret|session|token|api[-_]?key)$/i;
const MAX_LOG_DEPTH = 5;
const MAX_LOG_KEYS = 50;
const MAX_LOG_ARRAY_ITEMS = 50;
const MAX_LOG_STRING_LENGTH = 2_000;
const LOG_LEVEL_PRIORITY: Record<LogLevel | "silent", number> = {
  info: 10,
  warn: 20,
  error: 30,
  silent: Number.POSITIVE_INFINITY,
};

function configuredLogLevel(): LogLevel | "silent" {
  const candidate = process.env.LOG_LEVEL;
  return candidate === "warn" || candidate === "error" || candidate === "silent"
    ? candidate
    : "info";
}

function sanitizeLogValue(
  value: unknown,
  key: string | undefined,
  depth: number,
): unknown {
  if (key && SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return value.slice(0, MAX_LOG_STRING_LENGTH);
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof URL) return value.origin + value.pathname;
  if (value instanceof Error) return safeErrorFields(value);
  if (depth >= MAX_LOG_DEPTH) return "[TRUNCATED]";
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_LOG_ARRAY_ITEMS)
      .map((item) => sanitizeLogValue(item, undefined, depth + 1));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, MAX_LOG_KEYS)
        .flatMap(([childKey, childValue]) => {
          const sanitized = sanitizeLogValue(childValue, childKey, depth + 1);
          return sanitized === undefined ? [] : [[childKey, sanitized]];
        }),
    );
  }
  return String(value).slice(0, MAX_LOG_STRING_LENGTH);
}

function sanitizeLogFields(fields: LogFields): LogFields {
  return sanitizeLogValue(fields, undefined, 0) as LogFields;
}

function writeLog(level: LogLevel, event: string, fields: LogFields = {}): void {
  if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[configuredLogLevel()]) return;

  const record = {
    ...sanitizeLogFields(fields),
    timestamp: new Date().toISOString(),
    level,
    service: `${IDENTIFIER_PREFIX}-server`,
    process: process.env.APP_PROCESS_NAME || "api",
    environment: process.env.NODE_ENV || "development",
    release: process.env.BUILD_SHA || "development",
    event,
  };
  const line = JSON.stringify(record);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export function logInfo(event: string, fields?: LogFields): void {
  writeLog("info", event, fields);
}

export function logWarn(event: string, fields?: LogFields): void {
  writeLog("warn", event, fields);
}

export function logError(
  event: string,
  error: unknown,
  fields: LogFields = {},
): void {
  writeLog("error", event, {
    ...fields,
    ...(error === undefined ? {} : { error: safeErrorFields(error) }),
  });
}

export function safeErrorFields(error: unknown): SafeErrorFields {
  if (!(error instanceof Error)) return { errorName: "UnknownError" };
  const candidate = error as Error & { code?: unknown };
  return {
    errorName: candidate.name || "Error",
    ...(typeof candidate.code === "string" && /^[A-Z0-9_]{1,40}$/.test(candidate.code)
      ? { errorCode: candidate.code }
      : {}),
  };
}

export function resolveRequestId(value: string | undefined): string {
  const requestId = value?.trim();
  return requestId && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(requestId)
    ? requestId
    : crypto.randomUUID();
}

export function normalizeRoutePath(routePath: string): string {
  return routePath && routePath !== "/*" ? routePath.slice(0, 200) : "<unmatched>";
}

export function resolveHttpLogSampleRate(
  configured: number | undefined,
  environment: string,
): number {
  if (configured !== undefined) return Math.min(1, Math.max(0, configured));
  return environment === "production" ? 0.1 : 1;
}

function isSampled(requestId: string, sampleRate: number): boolean {
  if (sampleRate <= 0) return false;
  if (sampleRate >= 1) return true;

  let hash = 2166136261;
  for (let index = 0; index < requestId.length; index += 1) {
    hash ^= requestId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0x1_0000_0000 < sampleRate;
}

export function shouldLogHttpRequest(
  input: HttpRequestLogInput,
  options: HttpRequestLogOptions,
): boolean {
  if (input.status >= 500 || input.status === 429) return true;
  if (input.durationMs >= options.slowRequestMs) return true;
  if (
    !["GET", "HEAD", "OPTIONS"].includes(input.method) &&
    AUDITED_WRITE_PATHS.has(input.path)
  ) {
    return true;
  }
  if (OPERATIONAL_PATHS.has(input.path)) return false;
  return isSampled(input.requestId, options.sampleRate);
}

export function httpRequestLogLevel(
  status: number,
  durationMs: number,
  slowRequestMs: number,
): LogLevel {
  if (status >= 500) return "error";
  if (status >= 400 || durationMs >= slowRequestMs) return "warn";
  return "info";
}

export async function withRequestLog<T>(
  requestId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return requestLogStorage.run({ requestId, fields: {} }, operation);
}

export function getRequestId(): string | undefined {
  return requestLogStorage.getStore()?.requestId;
}

export function addRequestLogFields(fields: LogFields): void {
  const state = requestLogStorage.getStore();
  if (state) Object.assign(state.fields, fields);
}

export function captureRequestError(error: unknown, fields?: LogFields): void {
  const state = requestLogStorage.getStore();
  if (!state) return;
  state.error ??= safeErrorFields(error);
  if (fields) Object.assign(state.fields, fields);
}

export function logHttpRequest(
  input: HttpRequestLogInput,
  options: HttpRequestLogOptions,
): void {
  if (!shouldLogHttpRequest(input, options)) return;
  const state = requestLogStorage.getStore();
  writeLog(
    httpRequestLogLevel(input.status, input.durationMs, options.slowRequestMs),
    "http_request",
    {
      ...state?.fields,
      requestId: input.requestId,
      method: input.method,
      path: input.path,
      status: input.status,
      durationMs: input.durationMs,
      ...(state?.error ? { error: state.error } : {}),
    },
  );
}
