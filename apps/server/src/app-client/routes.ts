import { readAppClientConfig, type AppClientConfigSnapshot } from "@northwind/api/app-client-config";
import {
  FeedbackRateLimited,
  FeedbackScreenshotUnavailable,
  claimableFeedbackScreenshot,
  feedbackScreenshots,
  reserveFeedbackScreenshot,
  submitAppFeedback,
  type NewFeedback,
} from "@northwind/api/app-feedback";
import { objectStorage, storedAsReserved, type ObjectStorage } from "@northwind/api/object-storage";
import { auth, sendPlatformEmail } from "@northwind/auth";
import {
  FEEDBACK_CATEGORIES,
  FEEDBACK_CONTEXTS,
  FEEDBACK_LIMITS,
} from "@northwind/env/app-client-config";
import { env } from "@northwind/env/server";
import { Hono, type Context } from "hono";
import { createHash } from "node:crypto";
import { z } from "zod";

import { captureRequestError, logWarn } from "../logging";

/**
 * The native iOS app's public endpoints (docs/app-feedback-rating.md): its
 * remote settings, a signed link to upload a screenshot straight to R2, and
 * feedback from its in-app form.
 */
type AppClientDependencies = {
  readConfig: () => Promise<AppClientConfigSnapshot>;
  submit: (feedback: NewFeedback) => Promise<{ id: string; createdAt: Date }>;
  reserveScreenshot: (input: { installationId: string; ipHash: string; byteLength: number }) => Promise<{ id: string; objectKey: string; createdAt: Date }>;
  claimableScreenshot: (uploadId: string, installationId: string) => Promise<{ objectKey: string; byteLength: number } | null>;
  /** `null` when R2 is not configured: screenshots are then off everywhere. */
  storage: ObjectStorage | null;
  getUserId: (headers: Headers) => Promise<string | null>;
  notify: (feedback: NewFeedback & { id: string }) => Promise<void>;
  secret: string;
};

const text = (max: number) => z.string().trim().min(1).max(max);

const diagnosticsSchema = z.strictObject({
  appVersion: text(32).optional(),
  build: text(32).optional(),
  os: text(32).optional(),
  device: text(64).optional(),
  locale: text(35).optional(),
  widgetFamilies: z.array(text(32)).max(8).optional(),
  pro: z.boolean().optional(),
  theme: text(32).optional(),
});

/** The shape checked before any setting-dependent rule. */
const feedbackBodySchema = z.strictObject({
  installationId: z.uuid(),
  category: z.enum(FEEDBACK_CATEGORIES),
  message: z.string().trim().min(1),
  contact: z.string().trim().max(FEEDBACK_LIMITS.contactLength).optional().nullable(),
  context: z.enum(FEEDBACK_CONTEXTS).optional().nullable(),
  diagnostics: diagnosticsSchema.default({}),
  screenshotUploadId: z.uuid().optional().nullable(),
});

const uploadBodySchema = z.strictObject({
  installationId: z.uuid(),
  byteLength: z.number().int().min(1).max(FEEDBACK_LIMITS.screenshotBytes),
});

const invalid = (field: string) => ({ error: "invalid_feedback", field }) as const;

function clientIp(headers: Headers) {
  // The edge proxy owns x-real-ip in production, as in the tRPC context.
  const forwarded = headers.get("x-forwarded-for");
  return headers.get("x-real-ip") ?? (forwarded ? forwarded.split(",").at(-1)?.trim() : undefined) ?? "local";
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]!
));

const categoryNames: Record<string, string> = { bug: "问题", suggestion: "建议", other: "其他" };

const defaultDependencies: AppClientDependencies = {
  readConfig: readAppClientConfig,
  submit: submitAppFeedback,
  reserveScreenshot: reserveFeedbackScreenshot,
  claimableScreenshot: claimableFeedbackScreenshot,
  storage: objectStorage,
  getUserId: async (headers) => {
    try {
      return (await auth.api.getSession({ headers }))?.user.id ?? null;
    } catch {
      // An unreadable session is no session: feedback still arrives, unattributed.
      return null;
    }
  },
  notify: async (feedback) => {
    const to = env.FEEDBACK_NOTIFY_EMAIL;
    if (!to) return;
    const link = `${env.CORS_ORIGIN.replace(/\/$/, "")}/admin/feedback?id=${feedback.id}`;
    const summary = [
      `类别：${categoryNames[feedback.category] ?? feedback.category}`,
      feedback.context ? `来自：${feedback.context}` : null,
      `版本：${feedback.diagnostics.appVersion ?? "未提供"}`,
      `登录：${feedback.userId ? "是" : "否"}`,
      `截图：${feedback.screenshotUploadId ? "有（在后台查看）" : "无"}`,
    ].filter(Boolean) as string[];
    const excerpt = feedback.message.length > 500 ? `${feedback.message.slice(0, 500)}…` : feedback.message;
    await sendPlatformEmail({
      to,
      subject: `Northwind反馈 · ${categoryNames[feedback.category] ?? feedback.category}`,
      text: `${summary.join("\n")}\n\n${excerpt}\n\n${link}`,
      html: `<p>${summary.map(escapeHtml).join("<br>")}</p><p style="white-space:pre-wrap">${escapeHtml(excerpt)}</p><p><a href="${escapeHtml(link)}">在后台查看</a></p>`,
    });
  },
  secret: env.BETTER_AUTH_SECRET,
};

/** Small JSON bodies only: the screenshot never passes through this service. */
async function readJson(c: Context): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const declared = Number(c.req.header("content-length") ?? "0");
  if (declared > FEEDBACK_LIMITS.requestBytes) return { ok: false };
  const raw = await c.req.text();
  if (raw.length > FEEDBACK_LIMITS.requestBytes) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

/** @public Used by app-client.integration.test.ts through a dynamic import knip cannot follow. */
export function createAppClientApp(overrides: Partial<AppClientDependencies> = {}) {
  const dependencies = { ...defaultDependencies, ...overrides };
  const ipHash = (headers: Headers) =>
    createHash("sha256").update(`${clientIp(headers)}:${dependencies.secret}`).digest("hex");

  return new Hono()
    .get("/api/app/config", async (c) => {
      try {
        const { revision, values } = await dependencies.readConfig();
        c.header("Cache-Control", "public, max-age=300");
        // Without storage there is nowhere to put a screenshot, whatever Admin chose.
        const feedback = { ...values.feedback, allowsScreenshot: values.feedback.allowsScreenshot && dependencies.storage !== null };
        return c.json({ revision, ...values, feedback });
      } catch (error) {
        // The app keeps its built-in defaults; never a reason to switch anything off.
        captureRequestError(error, { operation: "app_client_config" });
        c.header("Cache-Control", "no-store");
        return c.json({ error: "unavailable" }, 503);
      }
    })
    .post("/api/app/feedback/uploads", async (c) => {
      c.header("Cache-Control", "no-store");
      const json = await readJson(c);
      if (!json.ok) return c.json({ error: "invalid_upload", field: "body" }, 400);
      const parsed = uploadBodySchema.safeParse(json.value);
      if (!parsed.success) {
        const field = parsed.error.issues[0]?.path[0];
        return c.json({ error: "invalid_upload", field: typeof field === "string" ? field : "body" }, 400);
      }
      const storage = dependencies.storage;
      let reservation: { id: string; objectKey: string; createdAt: Date };
      try {
        const settings = (await dependencies.readConfig()).values.feedback;
        if (!storage || !settings.enabled || !settings.allowsScreenshot) return c.json({ error: "screenshots_disabled" }, 403);
        reservation = await dependencies.reserveScreenshot({
          installationId: parsed.data.installationId,
          ipHash: ipHash(c.req.raw.headers),
          byteLength: parsed.data.byteLength,
        });
      } catch (error) {
        if (error instanceof FeedbackRateLimited) {
          c.header("Retry-After", String(error.retryAfterSeconds));
          return c.json({ error: "rate_limited" }, 429);
        }
        captureRequestError(error, { operation: "app_feedback_upload" });
        return c.json({ error: "unavailable" }, 503);
      }
      // Signing is local: no call to R2 happens here.
      const ticket = await storage.presignUpload(reservation.objectKey, { contentType: "image/jpeg", byteLength: parsed.data.byteLength }, feedbackScreenshots.uploadSeconds);
      return c.json({
        uploadId: reservation.id,
        method: "PUT",
        url: ticket.url,
        headers: ticket.headers,
        expiresAt: new Date(reservation.createdAt.getTime() + feedbackScreenshots.uploadSeconds * 1_000).toISOString(),
      }, 201);
    })
    .post("/api/app/feedback", async (c) => {
      c.header("Cache-Control", "no-store");
      const json = await readJson(c);
      if (!json.ok) return c.json(invalid("body"), 400);
      const parsed = feedbackBodySchema.safeParse(json.value);
      if (!parsed.success) {
        const field = parsed.error.issues[0]?.path[0];
        return c.json(invalid(typeof field === "string" ? field : "body"), 400);
      }
      const body = parsed.data;

      let settings: AppClientConfigSnapshot["values"]["feedback"];
      try {
        settings = (await dependencies.readConfig()).values.feedback;
      } catch (error) {
        captureRequestError(error, { operation: "app_feedback_config" });
        return c.json({ error: "unavailable" }, 503);
      }
      if (!settings.enabled) return c.json({ error: "feedback_disabled" }, 403);
      if (!settings.categories.includes(body.category)) return c.json(invalid("category"), 400);
      if (body.message.length > settings.maxMessageLength) return c.json(invalid("message"), 400);

      if (body.screenshotUploadId) {
        const storage = dependencies.storage;
        if (!storage || !settings.allowsScreenshot) return c.json(invalid("screenshotUploadId"), 400);
        try {
          const upload = await dependencies.claimableScreenshot(body.screenshotUploadId, body.installationId);
          if (!upload) return c.json(invalid("screenshotUploadId"), 400);
          // What is in R2 is what was reserved: present, the same size, a JPEG.
          if (!await storedAsReserved(storage, feedbackScreenshots, upload.objectKey, { contentType: "image/jpeg", byteLength: upload.byteLength })) {
            return c.json(invalid("screenshotUploadId"), 400);
          }
        } catch (error) {
          captureRequestError(error, { operation: "app_feedback_screenshot_check" });
          return c.json({ error: "unavailable" }, 503);
        }
      }

      const feedback: NewFeedback = {
        installationId: body.installationId,
        ipHash: ipHash(c.req.raw.headers),
        userId: await dependencies.getUserId(c.req.raw.headers),
        category: body.category,
        message: body.message,
        contact: body.contact || null,
        context: body.context ?? null,
        diagnostics: body.diagnostics,
        screenshotUploadId: body.screenshotUploadId ?? null,
      };

      let saved: { id: string };
      try {
        saved = await dependencies.submit(feedback);
      } catch (error) {
        if (error instanceof FeedbackRateLimited) {
          c.header("Retry-After", String(error.retryAfterSeconds));
          return c.json({ error: "rate_limited" }, 429);
        }
        if (error instanceof FeedbackScreenshotUnavailable) return c.json(invalid("screenshotUploadId"), 400);
        captureRequestError(error, { operation: "app_feedback_submit" });
        return c.json({ error: "unavailable" }, 503);
      }

      // Saved first; telling the operator is best effort and never repeats the save.
      void dependencies.notify({ ...feedback, id: saved.id }).catch((error) => {
        logWarn("app_feedback_notify_failed", { error: error instanceof Error ? error.name : "unknown" });
      });
      return c.json({ id: saved.id }, 201);
    });
}

export const appClientApp = createAppClientApp();
