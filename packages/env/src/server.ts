import "dotenv/config";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

import { platformServerSchema } from "./platform-server-schema";
import { appStoreServerSchema } from "./app-store";
import { objectStorageEnvSchema } from "./object-storage";

export const env = createEnv({
  server: {
    ...platformServerSchema,
    ...appStoreServerSchema,
    /**
     * Model-facing history budget. Mastra still persists the complete thread;
     * only the context sent to each model step is trimmed to this ceiling.
     */
    ASSISTANT_CONTEXT_TOKEN_LIMIT: z.coerce
      .number()
      .int()
      .min(8_000)
      .max(1_000_000)
      .default(32_000),
    /** Mastra traces are operational telemetry; conversation history is retained separately. */
    MASTRA_TRACE_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(14),
    /**
     * iOS app 反馈的通知邮箱（docs/app-feedback-rating.md）。未设置时只保存、不通知。
     * 通过已有的 Cloudflare 邮件配置发送。
     */
    FEEDBACK_NOTIFY_EMAIL: z.string().trim().email().optional(),
    /** The object store for uploads; all or none (resolveObjectStorageConfig). */
    ...objectStorageEnvSchema,
  },
  runtimeEnv: process.env,
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  emptyStringAsUndefined: true,
});
