import { afterEach, describe, expect, spyOn, test } from "bun:test";

import {
  captureRequestError,
  getRequestId,
  httpRequestLogLevel,
  logError,
  logHttpRequest,
  normalizeRoutePath,
  resolveHttpLogSampleRate,
  resolveRequestId,
  safeErrorFields,
  shouldLogHttpRequest,
  withRequestLog,
} from "./logging";

const originalLogLevel = process.env.LOG_LEVEL;

afterEach(() => {
  // Assigning undefined would store the string "undefined", which later files
  // that load the server env then reject as a log level.
  if (originalLogLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = originalLogLevel;
});

describe("structured logging", () => {
  test("keeps only safe error identity fields", () => {
    const error = Object.assign(new Error("password=should-not-appear"), {
      code: "DATABASE_UNAVAILABLE",
    });

    expect(safeErrorFields(error)).toEqual({
      errorName: "Error",
      errorCode: "DATABASE_UNAVAILABLE",
    });
    expect(safeErrorFields({ message: "raw secret" })).toEqual({
      errorName: "UnknownError",
    });
  });

  test("emits bounded JSON and redacts sensitive keys", () => {
    process.env.LOG_LEVEL = "info";
    const sink = spyOn(console, "error").mockImplementation(() => undefined);

    logError(
      "billing_failed",
      Object.assign(new Error("sk-secret-value"), { code: "E_BILLING" }),
      { apiKey: "sk-secret-value", detail: "x".repeat(3_000), operation: "catalog" },
    );

    const record = JSON.parse(String(sink.mock.calls[0]?.[0]));
    expect(record).toMatchObject({
      level: "error",
      service: "northwind-server",
      event: "billing_failed",
      apiKey: "[REDACTED]",
      operation: "catalog",
      error: { errorName: "Error", errorCode: "E_BILLING" },
    });
    expect(record.detail).toHaveLength(2_000);
    expect(JSON.stringify(record)).not.toContain("sk-secret-value");
    sink.mockRestore();
  });

  test("accepts only log-safe request IDs", () => {
    expect(resolveRequestId("edge-req_123:abc")).toBe("edge-req_123:abc");
    expect(resolveRequestId("bad\nrequest")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  test("uses route templates and hides unmatched raw paths", () => {
    expect(normalizeRoutePath("/api/assistant/threads/:threadId")).toBe(
      "/api/assistant/threads/:threadId",
    );
    expect(normalizeRoutePath("/*")).toBe("<unmatched>");
  });

  test("defaults production success sampling to ten percent", () => {
    expect(resolveHttpLogSampleRate(undefined, "production")).toBe(0.1);
    expect(resolveHttpLogSampleRate(undefined, "development")).toBe(1);
    expect(resolveHttpLogSampleRate(2, "production")).toBe(1);
    expect(resolveHttpLogSampleRate(-1, "production")).toBe(0);
  });

  test("drops routine health checks but keeps failures and slow requests", () => {
    const base = {
      requestId: "req-health",
      method: "GET",
      path: "/readyz",
      status: 200,
      durationMs: 20,
    };
    const options = { sampleRate: 1, slowRequestMs: 1_000 };

    expect(shouldLogHttpRequest(base, options)).toBe(false);
    expect(shouldLogHttpRequest({ ...base, status: 503 }, options)).toBe(true);
    expect(shouldLogHttpRequest({ ...base, durationMs: 1_001 }, options)).toBe(true);
  });

  test("always keeps rate limits and auth writes while sampling routine 4xx", () => {
    const options = { sampleRate: 0, slowRequestMs: 1_000 };
    const base = {
      requestId: "req-policy",
      method: "GET",
      path: "<unmatched>",
      status: 404,
      durationMs: 20,
    };

    expect(shouldLogHttpRequest(base, options)).toBe(false);
    expect(shouldLogHttpRequest({ ...base, status: 429 }, options)).toBe(true);
    expect(
      shouldLogHttpRequest(
        { ...base, method: "POST", path: "/api/auth/*", status: 200 },
        options,
      ),
    ).toBe(true);
  });

  test("keeps errors and slow requests at actionable levels", () => {
    expect(httpRequestLogLevel(200, 20, 1_000)).toBe("info");
    expect(httpRequestLogLevel(200, 1_001, 1_000)).toBe("warn");
    expect(httpRequestLogLevel(404, 20, 1_000)).toBe("warn");
    expect(httpRequestLogLevel(500, 20, 1_000)).toBe("error");
  });

  test("propagates a request ID only inside its request context", async () => {
    expect(getRequestId()).toBeUndefined();
    await withRequestLog("req-context", async () => {
      await Promise.resolve();
      expect(getRequestId()).toBe("req-context");
    });
    expect(getRequestId()).toBeUndefined();
  });

  test("merges a caught failure into one request event", async () => {
    process.env.LOG_LEVEL = "info";
    const sink = spyOn(console, "error").mockImplementation(() => undefined);

    await withRequestLog("req-wide-event", async () => {
      captureRequestError(
        Object.assign(new Error("private database detail"), { code: "E_DATABASE" }),
        { operation: "assistant_thread_list" },
      );
      logHttpRequest(
        {
          requestId: "req-wide-event",
          method: "GET",
          path: "/api/assistant/threads",
          status: 500,
          durationMs: 12,
        },
        { sampleRate: 0, slowRequestMs: 1_000 },
      );
    });

    expect(sink).toHaveBeenCalledTimes(1);
    const record = JSON.parse(String(sink.mock.calls[0]?.[0]));
    expect(record).toMatchObject({
      event: "http_request",
      requestId: "req-wide-event",
      operation: "assistant_thread_list",
      status: 500,
      error: { errorName: "Error", errorCode: "E_DATABASE" },
    });
    expect(JSON.stringify(record)).not.toContain("private database detail");
    sink.mockRestore();
  });
});
