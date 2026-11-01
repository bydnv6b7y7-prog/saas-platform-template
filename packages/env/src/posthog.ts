import { z } from "zod";

import { POSTHOG_UI_HOST } from "./posthog-hosts";

export { POSTHOG_BROWSER_PROXY_HOST, POSTHOG_INGESTION_HOST, POSTHOG_UI_HOST } from "./posthog-hosts";

const posthogProjectTokenPattern = /^phc_[A-Za-z0-9_-]{20,}$/;
const posthogPersonalApiKeyPattern = /^phx_[A-Za-z0-9_-]{10,}$/;
const posthogProjectIdPattern = /^\d{1,12}$/;

export const posthogProjectTokenSchema = z
  .string()
  .trim()
  .regex(posthogProjectTokenPattern, "Must be a PostHog project token");

export const posthogPersonalApiKeySchema = z
  .string()
  .trim()
  .regex(posthogPersonalApiKeyPattern, "Must be a PostHog personal API key");

export const posthogProjectIdSchema = z
  .string()
  .trim()
  .regex(posthogProjectIdPattern, "Must be a numeric PostHog project ID");

export function isPostHogProjectToken(value: unknown): value is string {
  return typeof value === "string" && posthogProjectTokenPattern.test(value.trim());
}

export type PostHogDeletionConfiguration =
  | { configured: false }
  | {
      configured: true;
      host: string;
      projectId: string;
      personalApiKey: string;
    };

export type PostHogDeletionEnvironment = {
  POSTHOG_PERSONAL_API_KEY?: string;
  POSTHOG_PROJECT_ID?: string;
};

/**
 * Person deletion requires a personal API key; the project token cannot
 * manage people. Both values must be present together or neither.
 */
export function resolvePostHogDeletionConfig(
  environment: PostHogDeletionEnvironment,
): PostHogDeletionConfiguration {
  const personalApiKey = environment.POSTHOG_PERSONAL_API_KEY?.trim() || undefined;
  const projectId = environment.POSTHOG_PROJECT_ID?.trim() || undefined;

  if (!personalApiKey && !projectId) return { configured: false };

  if (!personalApiKey || !projectId) {
    throw new Error(
      "Incomplete PostHog deletion configuration; POSTHOG_PERSONAL_API_KEY and POSTHOG_PROJECT_ID must be set together",
    );
  }

  const key = posthogPersonalApiKeySchema.parse(personalApiKey);
  const id = posthogProjectIdSchema.parse(projectId);
  return {
    configured: true,
    host: POSTHOG_UI_HOST,
    projectId: id,
    personalApiKey: key,
  };
}
