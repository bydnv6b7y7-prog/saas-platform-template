import { z } from "zod";

import { FEEDBACK_CONTEXTS, REVIEW_TRIGGERS } from "./apple-application";

export { FEEDBACK_CONTEXTS, REVIEW_TRIGGERS };

/**
 * Remote settings for the native iOS app: when to ask for an App Store review,
 * and how the in-app feedback form behaves. One contract for the API, Admin and
 * the app's built-in defaults (docs/app-feedback-rating.md). The app ignores
 * enum values it does not know, so adding one here never breaks older builds.
 */
export const FEEDBACK_CATEGORIES = ["bug", "suggestion", "other"] as const;

const unique = <T extends z.ZodTypeAny>(item: T, max: number) =>
  z.array(item).max(max).refine((values) => new Set(values).size === values.length, "Values must be unique");

const reviewPolicySchema = z.strictObject({
  enabled: z.boolean(),
  minDaysSinceInstall: z.number().int().min(0).max(365),
  minActiveDays: z.number().int().min(0).max(365),
  /** Either the widget is on the Home Screen, or the app was opened on `minActiveDays` days. */
  requiresWidgetOrActiveDays: z.boolean(),
  cooldownDays: z.number().int().min(1).max(365),
  oncePerVersion: z.boolean(),
  triggers: unique(z.enum(REVIEW_TRIGGERS), REVIEW_TRIGGERS.length),
  delaySeconds: z.number().min(0).max(10),
});

const feedbackSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  categories: unique(z.enum(FEEDBACK_CATEGORIES), FEEDBACK_CATEGORIES.length)
    .refine((values) => values.length > 0, "At least one category"),
  maxMessageLength: z.number().int().min(50).max(5_000),
  allowsScreenshot: z.boolean(),
  contextualEntries: unique(z.enum(FEEDBACK_CONTEXTS), FEEDBACK_CONTEXTS.length),
});

export const appClientConfigSchema = z.strictObject({
  review: reviewPolicySchema,
  feedback: feedbackSettingsSchema,
});

export type AppClientConfig = z.infer<typeof appClientConfigSchema>;

export const APP_CLIENT_CONFIG_DEFAULTS: Readonly<AppClientConfig> = Object.freeze({
  review: Object.freeze({
    enabled: true,
    minDaysSinceInstall: 7,
    minActiveDays: 3,
    requiresWidgetOrActiveDays: true,
    cooldownDays: 60,
    oncePerVersion: true,
    triggers: [...REVIEW_TRIGGERS],
    delaySeconds: 1,
  }),
  feedback: Object.freeze({
    enabled: true,
    categories: ["bug", "suggestion", "other"],
    maxMessageLength: 1_000,
    allowsScreenshot: true,
    contextualEntries: [...FEEDBACK_CONTEXTS],
  }),
}) as AppClientConfig;

/** Upper bounds that do not change with configuration. */
export const FEEDBACK_LIMITS = Object.freeze({
  contactLength: 120,
  screenshotBytes: 1_000_000,
  /** The feedback body itself; screenshots go straight to storage. */
  requestBytes: 65_536,
  /** One installation. */
  perHour: 5,
  perDay: 20,
  /** One network address: looser, since many readers can share one behind a NAT. */
  ipPerHour: 20,
  ipPerDay: 100,
  screenshotRetentionDays: 180,
  /** Screenshot uploads the service will sign, per installation and per address. */
  uploadsPerHour: 10,
  ipUploadsPerHour: 40,
  /** An upload must be sent with feedback within this long… */
  uploadClaimSeconds: 3_600,
  /** …and one never sent is deleted after this long. */
  unclaimedUploadHours: 24,
});
