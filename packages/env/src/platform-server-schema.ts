import { z } from "zod";

import { COPILOT_MODEL_PROVIDERS } from "./copilot";
import { emailServerSchema } from "./email";
import {
  POSTHOG_INGESTION_HOST,
  posthogPersonalApiKeySchema,
  posthogProjectIdSchema,
  posthogProjectTokenSchema,
} from "./posthog";

const optionalNonEmptyString = z.string().trim().min(1).optional();

/**
 * Infrastructure and account capabilities shared by every product built from
 * this stack. Product-specific settings stay in server.ts.
 */
export const platformServerSchema = {
  ...emailServerSchema,
  DATABASE_URL: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.url(),
  CORS_ORIGIN: z.url(),
  GOOGLE_CLIENT_ID: optionalNonEmptyString,
  GOOGLE_IOS_CLIENT_ID: optionalNonEmptyString,
  GOOGLE_CLIENT_SECRET: optionalNonEmptyString,
  GITHUB_CLIENT_ID: optionalNonEmptyString,
  GITHUB_CLIENT_SECRET: optionalNonEmptyString,
  APPLE_CLIENT_ID: optionalNonEmptyString,
  APPLE_TEAM_ID: optionalNonEmptyString,
  APPLE_KEY_ID: optionalNonEmptyString,
  /** Base64-encoded contents of the Sign in with Apple .p8 private key. */
  APPLE_PRIVATE_KEY_BASE64: optionalNonEmptyString,
  STRIPE_SECRET_KEY: optionalNonEmptyString,
  STRIPE_WEBHOOK_SECRET: optionalNonEmptyString,
  STRIPE_PRICE_PRO_MONTHLY: optionalNonEmptyString,
  STRIPE_PRICE_PRO_YEARLY: optionalNonEmptyString,
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  /** Set by deploy:provision: production (Live Stripe keys) or staging (test keys). */
  DEPLOY_STAGE: z.enum(["production", "staging"]).default("production"),
  LOG_LEVEL: z.enum(["info", "warn", "error", "silent"]).default("info"),
  /** Routine HTTP sample rate. Server errors, rate limits, slow requests, and auth writes are kept. */
  HTTP_LOG_SAMPLE_RATE: z.coerce.number().min(0).max(1).optional(),
  HTTP_SLOW_REQUEST_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
  PORT: z.coerce.number().int().min(1024).max(65535).default(3000),
  BUILD_SHA: z.string().min(1).default("development"),
  BUILD_TIME: z.string().min(1).default("unknown"),
  /** Better Auth Admin Plugin bootstrap user IDs. Never authorize by mutable email. */
  ADMIN_USER_IDS: z.string().default(""),
  METRICS_TOKEN: z.string().min(24).optional(),
  POSTHOG_PROJECT_TOKEN: posthogProjectTokenSchema.optional(),
  POSTHOG_HOST: z.url().default(POSTHOG_INGESTION_HOST),
  /** Personal API key + project ID enable person deletion on account deletion. Set together. */
  POSTHOG_PERSONAL_API_KEY: posthogPersonalApiKeySchema.optional(),
  POSTHOG_PROJECT_ID: posthogProjectIdSchema.optional(),
  COPILOT_MODEL_PROVIDER: z.enum(COPILOT_MODEL_PROVIDERS).default("openai-compatible"),
  COPILOT_MODEL: optionalNonEmptyString,
  DEEPSEEK_API_KEY: optionalNonEmptyString,
  OPENROUTER_API_KEY: optionalNonEmptyString,
  LLM_API_KEY: optionalNonEmptyString,
  LLM_BASE_URL: z.string().url().optional(),
  LLM_MODEL: optionalNonEmptyString,
};
