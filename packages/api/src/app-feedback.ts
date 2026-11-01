import { and, db, desc, eq, gt, isNotNull, isNull, lt, or, sql } from "@northwind/db";
import { appFeedback, appFeedbackScreenshot, type AppFeedbackDiagnostics } from "@northwind/db/schema/app-feedback";
import { FEEDBACK_LIMITS } from "@northwind/env/app-client-config";
import { env } from "@northwind/env/server";

import { IMAGE_TYPES, objectKey, objectStorage, type ObjectStorage, type StoragePurpose } from "./object-storage";

/** Screenshots from the app's feedback form; the app sends JPEG only. */
export const feedbackScreenshots = {
  name: "app-feedback",
  types: { "image/jpeg": IMAGE_TYPES["image/jpeg"] },
  maxBytes: FEEDBACK_LIMITS.screenshotBytes,
  uploadSeconds: 600,
  viewSeconds: 600,
} satisfies StoragePurpose;

export type NewFeedback = {
  installationId: string;
  ipHash: string;
  /** From the session only. */
  userId: string | null;
  category: string;
  message: string;
  contact: string | null;
  context: string | null;
  diagnostics: AppFeedbackDiagnostics;
  /** An upload this installation reserved and the service has already checked in storage. */
  screenshotUploadId: string | null;
};

/** A reserved upload that can no longer be attached: gone, used, expired, or someone else's. */
export class FeedbackScreenshotUnavailable extends Error {
  constructor() {
    super("Screenshot upload unavailable");
    this.name = "FeedbackScreenshotUnavailable";
  }
}

/** Too much feedback from one installation or one address; retry after the given seconds. */
export class FeedbackRateLimited extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super("Too much feedback");
    this.name = "FeedbackRateLimited";
  }
}

type FeedbackStatus = "new" | "done";

const HOUR = 3_600;
const DAY = 86_400;

/**
 * Inject a dedicated database for integration tests. Objects are filed under the
 * environment (the same NODE_ENV the logs report), so development and production
 * sharing one bucket keep apart and can be managed separately.
 */
export function createAppFeedbackStore(
  database: typeof db,
  now: () => Date = () => new Date(),
  environment: string = env.NODE_ENV,
) {
  return {
    /**
     * Counting and inserting share one transaction, serialised per installation,
     * so two requests at once cannot both slip under the limit.
     */
    /**
     * Writes the ledger row before anything is signed, so every object that can
     * exist in storage has a row that will delete it.
     */
    async reserveScreenshot(input: { installationId: string; ipHash: string; byteLength: number }) {
      return database.transaction(async (transaction) => {
        await transaction.execute(sql`select pg_advisory_xact_lock(814, hashtext(${input.installationId}))`);
        const at = now();
        const since = new Date(at.getTime() - HOUR * 1_000);
        const checks: [typeof appFeedbackScreenshot.installationId | typeof appFeedbackScreenshot.ipHash, string, number][] = [
          [appFeedbackScreenshot.installationId, input.installationId, FEEDBACK_LIMITS.uploadsPerHour],
          [appFeedbackScreenshot.ipHash, input.ipHash, FEEDBACK_LIMITS.ipUploadsPerHour],
        ];
        for (const [column, value, limit] of checks) {
          const [row] = await transaction.select({
            count: sql<number>`count(*)::int`,
            oldest: sql<Date | null>`min(${appFeedbackScreenshot.createdAt})`,
          }).from(appFeedbackScreenshot).where(and(eq(column, value), gt(appFeedbackScreenshot.createdAt, since)));
          if ((row?.count ?? 0) >= limit) {
            const freesAt = new Date(row?.oldest ?? at).getTime() + HOUR * 1_000;
            throw new FeedbackRateLimited(Math.max(1, Math.ceil((freesAt - at.getTime()) / 1_000)));
          }
        }
        const id = crypto.randomUUID();
        const key = objectKey(feedbackScreenshots, { id, contentType: "image/jpeg", at, environment });
        await transaction.insert(appFeedbackScreenshot).values({
          id, objectKey: key, installationId: input.installationId, ipHash: input.ipHash, byteLength: input.byteLength, createdAt: at,
        });
        return { id, objectKey: key, createdAt: at };
      });
    },

    /** A reserved upload this installation may still attach, or `null`. */
    async claimableScreenshot(uploadId: string, installationId: string) {
      const cutoff = new Date(now().getTime() - FEEDBACK_LIMITS.uploadClaimSeconds * 1_000);
      const [row] = await database.select({
        objectKey: appFeedbackScreenshot.objectKey,
        byteLength: appFeedbackScreenshot.byteLength,
      }).from(appFeedbackScreenshot).where(and(
        eq(appFeedbackScreenshot.id, uploadId),
        eq(appFeedbackScreenshot.installationId, installationId),
        isNull(appFeedbackScreenshot.feedbackId),
        isNull(appFeedbackScreenshot.attachedAt),
        gt(appFeedbackScreenshot.createdAt, cutoff),
      ));
      return row ?? null;
    },

    async submit(input: NewFeedback): Promise<{ id: string; createdAt: Date }> {
      return database.transaction(async (transaction) => {
        // A namespace of its own (813), apart from settings (812, n) and ingestion.
        await transaction.execute(sql`select pg_advisory_xact_lock(813, hashtext(${input.installationId}))`);
        const at = now();
        const windowStart = (seconds: number) => new Date(at.getTime() - seconds * 1_000);
        const count = async (column: typeof appFeedback.installationId | typeof appFeedback.ipHash, value: string, seconds: number) => {
          const [row] = await transaction.select({
            count: sql<number>`count(*)::int`,
            oldest: sql<Date | null>`min(${appFeedback.createdAt})`,
          }).from(appFeedback)
            .where(and(eq(column, value), sql`${appFeedback.createdAt} > ${windowStart(seconds)}`));
          return { count: row?.count ?? 0, oldest: row?.oldest ? new Date(row.oldest) : null };
        };
        const checks: [typeof appFeedback.installationId | typeof appFeedback.ipHash, string, number, number][] = [
          [appFeedback.installationId, input.installationId, HOUR, FEEDBACK_LIMITS.perHour],
          [appFeedback.installationId, input.installationId, DAY, FEEDBACK_LIMITS.perDay],
          [appFeedback.ipHash, input.ipHash, HOUR, FEEDBACK_LIMITS.ipPerHour],
          [appFeedback.ipHash, input.ipHash, DAY, FEEDBACK_LIMITS.ipPerDay],
        ];
        for (const [column, value, seconds, limit] of checks) {
          const { count: used, oldest } = await count(column, value, seconds);
          if (used >= limit) {
            // Free again once the oldest counted piece leaves the window.
            const freesAt = (oldest ?? at).getTime() + seconds * 1_000;
            throw new FeedbackRateLimited(Math.max(1, Math.ceil((freesAt - at.getTime()) / 1_000)));
          }
        }

        const id = crypto.randomUUID();
        await transaction.insert(appFeedback).values({
          id,
          installationId: input.installationId,
          userId: input.userId,
          ipHash: input.ipHash,
          category: input.category,
          message: input.message,
          contact: input.contact,
          context: input.context,
          diagnostics: input.diagnostics,
          hasScreenshot: input.screenshotUploadId !== null,
          createdAt: at,
        });
        if (input.screenshotUploadId) {
          // Claimed in the same transaction as the feedback: one upload, one
          // piece of feedback, and only by the installation that reserved it.
          const cutoff = new Date(at.getTime() - FEEDBACK_LIMITS.uploadClaimSeconds * 1_000);
          const claimed = await transaction.update(appFeedbackScreenshot)
            .set({ feedbackId: id, attachedAt: at })
            .where(and(
              eq(appFeedbackScreenshot.id, input.screenshotUploadId),
              eq(appFeedbackScreenshot.installationId, input.installationId),
              isNull(appFeedbackScreenshot.feedbackId),
              isNull(appFeedbackScreenshot.attachedAt),
              gt(appFeedbackScreenshot.createdAt, cutoff),
            ))
            .returning({ id: appFeedbackScreenshot.id });
          if (claimed.length !== 1) throw new FeedbackScreenshotUnavailable();
        }
        return { id, createdAt: at };
      });
    },

    /** Newest first; never loads image bytes. */
    async list(input: { status?: FeedbackStatus; limit: number; cursor?: { createdAt: string; id: string } }) {
      const conditions = [
        input.status ? eq(appFeedback.status, input.status) : undefined,
        input.cursor ? or(
          lt(appFeedback.createdAt, new Date(input.cursor.createdAt)),
          and(eq(appFeedback.createdAt, new Date(input.cursor.createdAt)), lt(appFeedback.id, input.cursor.id)),
        ) : undefined,
      ].filter((condition) => condition !== undefined);
      const rows = await database.select({
        id: appFeedback.id,
        category: appFeedback.category,
        message: appFeedback.message,
        context: appFeedback.context,
        hasScreenshot: appFeedback.hasScreenshot,
        status: appFeedback.status,
        signedIn: sql<boolean>`${appFeedback.userId} is not null`,
        appVersion: sql<string | null>`${appFeedback.diagnostics}->>'appVersion'`,
        createdAt: appFeedback.createdAt,
      }).from(appFeedback)
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(appFeedback.createdAt), desc(appFeedback.id))
        .limit(input.limit + 1);
      const page = rows.slice(0, input.limit);
      const last = page.at(-1);
      return {
        items: page.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
        nextCursor: rows.length > input.limit && last ? { createdAt: last.createdAt.toISOString(), id: last.id } : null,
      };
    },

    async detail(id: string) {
      const [row] = await database.select().from(appFeedback).where(eq(appFeedback.id, id));
      if (!row) return null;
      const [screenshot] = row.hasScreenshot
        ? await database.select({ objectKey: appFeedbackScreenshot.objectKey })
          .from(appFeedbackScreenshot).where(eq(appFeedbackScreenshot.feedbackId, id))
        : [];
      return {
        id: row.id,
        category: row.category,
        message: row.message,
        contact: row.contact,
        context: row.context,
        diagnostics: row.diagnostics,
        signedIn: row.userId !== null,
        status: row.status as FeedbackStatus,
        handledAt: row.handledAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        /** Signed into a short-lived link by the admin router; never sent to a browser as a key. */
        screenshotKey: screenshot?.objectKey ?? null,
        screenshotExpired: row.hasScreenshot && !screenshot,
      };
    },

    async setStatus(input: { id: string; status: FeedbackStatus; actorId: string }) {
      const [row] = await database.update(appFeedback)
        .set(input.status === "done"
          ? { status: "done", handledBy: input.actorId, handledAt: now() }
          : { status: "new", handledBy: null, handledAt: null })
        .where(eq(appFeedback.id, input.id))
        .returning({ id: appFeedback.id, status: appFeedback.status });
      return row ?? null;
    },

    /**
     * Deletes screenshot objects that should no longer exist, then their rows:
     * unclaimed after a day, claimed but past retention, or left behind when
     * their feedback was deleted. A failed deletion keeps its row for next time.
     */
    async purgeScreenshots(storage: ObjectStorage | null, batch = 200) {
      if (!storage) return { deleted: 0, failed: 0 };
      const at = now().getTime();
      const unclaimedBefore = new Date(at - FEEDBACK_LIMITS.unclaimedUploadHours * HOUR * 1_000);
      const retainedAfter = new Date(at - FEEDBACK_LIMITS.screenshotRetentionDays * DAY * 1_000);
      const due = await database.select({ id: appFeedbackScreenshot.id, objectKey: appFeedbackScreenshot.objectKey })
        .from(appFeedbackScreenshot)
        .where(or(
          and(isNull(appFeedbackScreenshot.attachedAt), lt(appFeedbackScreenshot.createdAt, unclaimedBefore)),
          and(isNotNull(appFeedbackScreenshot.attachedAt), isNull(appFeedbackScreenshot.feedbackId)),
          lt(appFeedbackScreenshot.attachedAt, retainedAfter),
        ))
        .limit(batch);
      let deleted = 0;
      let failed = 0;
      for (const row of due) {
        try {
          await storage.delete(row.objectKey);
          await database.delete(appFeedbackScreenshot).where(eq(appFeedbackScreenshot.id, row.id));
          deleted += 1;
        } catch {
          failed += 1;
        }
      }
      return { deleted, failed };
    },
  };
}

const store = createAppFeedbackStore(db);

export const submitAppFeedback = store.submit;
export const listAppFeedback = store.list;
export const readAppFeedback = store.detail;
export const setAppFeedbackStatus = store.setStatus;
export const reserveFeedbackScreenshot = store.reserveScreenshot;
export const claimableFeedbackScreenshot = store.claimableScreenshot;
export const purgeFeedbackScreenshots = () => store.purgeScreenshots(objectStorage);
