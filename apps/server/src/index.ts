import { createContext } from "@northwind/api/context";
import { appRouter } from "@northwind/product/router";
import {
  auth,
  appStoreBilling,
  enabledSocialProviderIds,
  shutdownAnalytics,
  stripeBilling,
} from "@northwind/auth";
import { checkDb, closeDb, rawQuery } from "@northwind/db";
import { env } from "@northwind/env/server";
import { trpcServer } from "@hono/trpc-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { createHash } from "node:crypto";
import { startAppStoreMaintenance } from "@northwind/better-auth-app-store";
import { appStoreMetrics } from "./app-store-metrics";

import { appClientApp } from "./app-client/routes";
import { startStorageCleanup } from "./storage-cleanup";
import { objectStorage } from "@northwind/api/object-storage";
import { billingApp } from "./billing/routes";
import { assistantUsageApp } from "./billing/assistant-routes";
import { serverProduct } from "./product";
import {
  addRequestLogFields,
  captureRequestError,
  logError,
  logHttpRequest,
  logInfo,
  logWarn,
  normalizeRoutePath,
  resolveHttpLogSampleRate,
  resolveRequestId,
  withRequestLog,
} from "./logging";
import { agUiAgentRunner } from "./mastra/agent-runner";
import { registerAssistantAccountCleanup } from "./mastra/account-cleanup";
import { copilotRuntimeApp } from "./mastra/copilot-runtime";
import { mastra } from "./mastra";
import { getCopilotModelStatus } from "./mastra/model";
import { startMastraRetentionScheduler } from "./mastra/retention";
import { assistantThreadApp } from "./mastra/thread-routes";

const app = new Hono();
appStoreBilling.onEvent(event => {
  if (/Failed|Blocked|Unknown/.test(event.name)) logWarn("app_store", event);
});
// Self-service account deletion cleans assistant history through this hook.
registerAssistantAccountCleanup();
const startedAt = Date.now();
let requestCount = 0;
let errorCount = 0;
const httpLogOptions = {
  sampleRate: resolveHttpLogSampleRate(env.HTTP_LOG_SAMPLE_RATE, env.NODE_ENV),
  slowRequestMs: env.HTTP_SLOW_REQUEST_MS,
};
const analyticsTokenFingerprint = env.POSTHOG_PROJECT_TOKEN
  ? createHash("sha256").update(env.POSTHOG_PROJECT_TOKEN).digest("hex").slice(0, 12)
  : null;

app.use(async (c, next) => {
  const requestStartedAt = performance.now();
  const requestId = resolveRequestId(c.req.header("x-request-id"));
  c.header("x-request-id", requestId);
  requestCount += 1;
  await withRequestLog(requestId, async () => {
    let failed = false;
    try {
      await next();
      if (c.res.status >= 500) errorCount += 1;
    } catch (error) {
      failed = true;
      errorCount += 1;
      captureRequestError(error);
      throw error;
    } finally {
      const durationMs = Math.round((performance.now() - requestStartedAt) * 10) / 10;
      logHttpRequest(
        {
          requestId,
          method: c.req.method,
          path: normalizeRoutePath(c.req.routePath),
          status: failed ? 500 : c.res.status,
          durationMs,
        },
        httpLogOptions,
      );
    }
  });
});
app.use(secureHeaders());
app.use(
  "/*",
  cors({
    origin: env.CORS_ORIGIN,
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "X-Request-Id"],
    exposeHeaders: ["X-Request-Id", "X-Retry-After", "Retry-After"],
    credentials: true,
  }),
);

app.get("/api/auth/providers", (c) => {
  c.header("Cache-Control", "public, max-age=300");
  return c.json({ providers: enabledSocialProviderIds });
});

app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));
app.route("/", billingApp);
app.route("/", appClientApp);

app.route("/", assistantUsageApp);
app.route("/", assistantThreadApp);
app.route("/", copilotRuntimeApp);

app.use(
  "/trpc/*",
  trpcServer({
    router: appRouter,
    createContext: (_opts, context) => createContext({ context }),
    onError: ({ error, path }) => {
      captureRequestError(error, {
        operation: path ? `trpc.${path}` : "trpc",
      });
    },
  }),
);

app.get("/livez", (c) => c.json({ status: "live" }));
app.get("/readyz", async (c) => {
  const connected = await checkDb();
  if (!connected) {
    addRequestLogFields({ operation: "readiness_database" });
    return c.json({ status: "not_ready", database: false }, 503);
  }
  const schema = await rawQuery<{
    ready: boolean;
    auth_ready: boolean;
    mastra_ready: boolean;
  }>(
    `SELECT (SELECT COALESCE(bool_and(to_regclass(name) IS NOT NULL), true) FROM unnest($1::text[]) AS name)
         AND to_regclass('public.runtime_settings') IS NOT NULL
         AND to_regclass('public.runtime_settings_audit') IS NOT NULL
         AND to_regclass('public.iap_admin_action') IS NOT NULL
         AND to_regclass('public.app_client_config') IS NOT NULL
         AND to_regclass('public.app_client_config_audit') IS NOT NULL
         AND to_regclass('public.app_feedback') IS NOT NULL
         AND to_regclass('public.app_feedback_screenshot') IS NOT NULL AS ready,
         to_regclass('public.subscription') IS NOT NULL
         AND 5 = (
           SELECT count(*) FROM information_schema.columns
           WHERE table_schema = 'public'
             AND (table_name, column_name) IN (
               ('user', 'role'),
               ('user', 'banned'),
               ('user', 'ban_reason'),
               ('user', 'ban_expires'),
               ('session', 'impersonated_by')
             )
         )
         -- Better Auth 1.7.3+ never writes account.issuer; NOT NULL would reject sign-ups (migration 0019).
         AND NOT EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'account'
             AND column_name = 'issuer' AND is_nullable = 'NO'
         ) AS auth_ready,
         to_regclass('mastra.mastra_threads') IS NOT NULL
         AND to_regclass('mastra.ag_ui_runs') IS NOT NULL
         AND to_regclass('mastra.ag_ui_events') IS NOT NULL AS mastra_ready`,
    [[...serverProduct.readinessTables]],
  ).catch((error) => {
    captureRequestError(error, { operation: "readiness_schema" });
    return { rows: [{ ready: false, auth_ready: false, mastra_ready: false }] };
  });
  const dataSchemaReady = schema.rows[0]?.ready ?? false;
  const authSchemaReady = schema.rows[0]?.auth_ready ?? false;
  const mastraSchemaReady = schema.rows[0]?.mastra_ready ?? false;
  const copilotModelStatus = getCopilotModelStatus();
  const copilotReady = mastraSchemaReady && copilotModelStatus.configured;
  const ready = dataSchemaReady && authSchemaReady && copilotReady;
  return c.json(
    {
      status: ready ? "ready" : "not_ready",
      database: true,
      schema: dataSchemaReady,
      auth: { schema: authSchemaReady },
      copilot: {
        configured: copilotModelStatus.configured,
        schema: mastraSchemaReady,
        provider: copilotModelStatus.provider,
        model: copilotModelStatus.model,
      },
      billing: {
        configured: stripeBilling.configured,
        livemode: stripeBilling.livemode,
      },
      analytics: {
        configured: Boolean(env.POSTHOG_PROJECT_TOKEN),
        host: env.POSTHOG_PROJECT_TOKEN ? env.POSTHOG_HOST : null,
        tokenFingerprint: analyticsTokenFingerprint,
      },
      // Reported, not required: without a bucket, uploads are simply off.
      objectStorage: { configured: objectStorage !== null },
    },
    ready ? 200 : 503,
  );
});
app.get("/version", (c) =>
  c.json({ sha: env.BUILD_SHA, builtAt: env.BUILD_TIME, runtime: `bun-${Bun.version}` }),
);
app.get("/internal/metrics", async (c) => {
  if (!env.METRICS_TOKEN || c.req.header("authorization") !== `Bearer ${env.METRICS_TOKEN}`) {
    return c.notFound();
  }
  const memory = process.memoryUsage();
  const copilotConfigured = getCopilotModelStatus().configured;
  const lines = [
    "# TYPE app_uptime_seconds gauge",
    `app_uptime_seconds ${Math.floor((Date.now() - startedAt) / 1_000)}`,
    "# TYPE app_http_requests_total counter",
    `app_http_requests_total ${requestCount}`,
    "# TYPE app_http_errors_total counter",
    `app_http_errors_total ${errorCount}`,
    "# TYPE app_process_resident_memory_bytes gauge",
    `app_process_resident_memory_bytes ${memory.rss}`,
    "# TYPE app_copilot_configured gauge",
    `app_copilot_configured ${copilotConfigured ? 1 : 0}`,
    "# TYPE app_billing_configured gauge",
    `app_billing_configured ${stripeBilling.configured ? 1 : 0}`,
    "# TYPE app_billing_livemode gauge",
    `app_billing_livemode ${stripeBilling.livemode ? 1 : 0}`,
    "# TYPE app_analytics_configured gauge",
    `app_analytics_configured ${env.POSTHOG_PROJECT_TOKEN ? 1 : 0}`,
  ];
  lines.push(...await serverProduct.metrics());
  lines.push(...await appStoreMetrics(appStoreBilling.service));
  return c.text(lines.join("\n") + "\n", 200, { "content-type": "text/plain; version=0.0.4" });
});
app.get("/", (c) => {
  const copilotConfigured = getCopilotModelStatus().configured;
  return c.json({
    service: serverProduct.serviceName,
    status: "ok",
    ...serverProduct.status(),
    copilot: copilotConfigured ? "configured" : "unconfigured",
    billing: stripeBilling.configured ? "configured" : "unconfigured",
    analytics: env.POSTHOG_PROJECT_TOKEN ? "configured" : "unconfigured",
  });
});

app.onError((error, c) => {
  captureRequestError(error);
  const requestId = c.res.headers.get("x-request-id") ?? "unknown";
  return c.json({ error: "Internal server error", requestId }, 500);
});

let server: ReturnType<typeof Bun.serve>;
try {
  await appStoreBilling.service?.ready();
  server = Bun.serve({
    port: env.PORT,
    idleTimeout: 120,
    fetch: app.fetch,
  });
} catch (error) {
  const errorCode = error instanceof Error && "code" in error
    ? (error as Error & { code?: unknown }).code
    : undefined;
  logError("server_start_failed", error, {
    port: env.PORT,
    ...(errorCode === "EADDRINUSE"
      ? { reason: `Port ${env.PORT} is already in use; stop the existing server first.` }
      : {}),
  });
  await Promise.allSettled([
    agUiAgentRunner.shutdown(),
    mastra.shutdown(),
    shutdownAnalytics(),
    closeDb(),
  ]);
  process.exit(1);
}

const productWorkers = serverProduct.startWorkers();
const mastraRetention = startMastraRetentionScheduler();
const appStoreMaintenance = appStoreBilling.service ? startAppStoreMaintenance(appStoreBilling.service) : null;
// Timers are unref'd: shutdown does not wait for them, and an interrupted
// clean-up simply resumes from its ledger next time.
const stopStorageCleanup = objectStorage ? startStorageCleanup() : null;

logInfo("server_started", { port: server.port, sha: env.BUILD_SHA });

let shuttingDown = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    void (async () => {
      logInfo("server_shutdown", { signal });
      stopStorageCleanup?.();
      const drainResults = await Promise.allSettled([
        // Finish auth/webhook handlers before closing the DB or flushing analytics.
        server.stop(false),
        agUiAgentRunner.shutdown(),
        productWorkers?.stopAndDrain(),
        mastraRetention.stopAndDrain(),
        appStoreMaintenance?.stopAndDrain(),
      ]);
      const closeResults = await Promise.allSettled([
        mastra.shutdown(),
        shutdownAnalytics(),
        closeDb(),
      ]);
      const results = [...drainResults, ...closeResults];
      const failed = results.filter((result) => result.status === "rejected");
      if (failed.length > 0) {
        logError("server_shutdown_failed", undefined, { failures: failed.length });
      }
      process.exit(failed.length > 0 ? 1 : 0);
    })();
  });
}
