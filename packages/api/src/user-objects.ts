import { and, db, eq, inArray, isNotNull, isNull, lt, or, sql } from "@northwind/db";
import { storedObject } from "@northwind/db/schema/stored-object";

import { objectKey, objectStorage, storedAsReserved, uploadProblem, type ObjectStorage, type StoragePurpose } from "./object-storage";

export type Plan = "free" | "pro";

/** A purpose signed-in users upload for, with what each plan may keep at once. */
export type UserStoragePurpose = StoragePurpose & {
  quota: Record<Plan, { objects: number; bytes: number }>;
};

/** Why an upload was not signed. `quota` carries what is in use against which limit. */
export class UploadRefused extends Error {
  constructor(
    readonly reason: "type" | "size" | "quota" | "unavailable",
    readonly usage?: { objects: number; bytes: number; limit: { objects: number; bytes: number } },
  ) {
    super(`Upload refused: ${reason}`);
    this.name = "UploadRefused";
  }
}

/** An upload never confirmed within this long is deleted (and stops counting against the quota). */
const UNCONFIRMED_SECONDS = 3_600;

type Executor = Pick<typeof db, "update">;

/**
 * Uploads that belong to a signed-in user (docs/object-storage.md): reserve a
 * row and a signed PUT, confirm the bytes, show with a signed GET, release when
 * no longer needed. Ownership is checked on every call; storage never decides.
 */
export function createUserObjectStore(database: typeof db, storage: ObjectStorage | null, now: () => Date = () => new Date()) {
  const usage = async (executor: Pick<typeof db, "select">, userId: string, purpose: UserStoragePurpose) => {
    const [row] = await executor.select({
      objects: sql<number>`count(*)::int`,
      bytes: sql<number>`coalesce(sum(${storedObject.byteLength}), 0)::bigint`,
    }).from(storedObject).where(and(
      eq(storedObject.userId, userId),
      eq(storedObject.purpose, purpose.name),
      isNull(storedObject.releasedAt),
    ));
    return { objects: Number(row?.objects ?? 0), bytes: Number(row?.bytes ?? 0) };
  };

  return {
    /** What the user keeps under this purpose, the plan's limit, and whether uploads are possible at all. */
    async usage(userId: string, purpose: UserStoragePurpose, plan: Plan) {
      return { ...await usage(database, userId, purpose), limit: purpose.quota[plan], plan, available: storage !== null };
    },

    /** Writes the row before signing, so every object that can exist has a row that will delete it. */
    async reserve(input: { userId: string; plan: Plan; purpose: UserStoragePurpose; contentType: string; byteLength: number }) {
      if (!storage) throw new UploadRefused("unavailable");
      const problem = uploadProblem(input.purpose, input);
      if (problem) throw new UploadRefused(problem);
      const at = now();
      const id = crypto.randomUUID();
      const key = objectKey(input.purpose, { id, contentType: input.contentType, at });
      await database.transaction(async (transaction) => {
        // Serialised per user, so two uploads at once cannot both slip under the quota.
        await transaction.execute(sql`select pg_advisory_xact_lock(815, hashtext(${input.userId}))`);
        const used = await usage(transaction, input.userId, input.purpose);
        const limit = input.purpose.quota[input.plan];
        if (used.objects + 1 > limit.objects || used.bytes + input.byteLength > limit.bytes) {
          throw new UploadRefused("quota", { ...used, limit });
        }
        await transaction.insert(storedObject).values({
          id, purpose: input.purpose.name, userId: input.userId, objectKey: key,
          contentType: input.contentType, byteLength: input.byteLength, createdAt: at,
        });
      });
      // Signing is local: no call to storage happens here.
      const ticket = await storage.presignUpload(key, input, input.purpose.uploadSeconds);
      return { id, ...ticket, expiresAt: new Date(at.getTime() + input.purpose.uploadSeconds * 1_000) };
    },

    /** Checks the uploaded bytes once; `null` when the object is not this user's, is gone, or is not what was reserved. */
    async confirm(userId: string, purpose: UserStoragePurpose, id: string) {
      if (!storage) return null;
      const [row] = await database.select().from(storedObject).where(and(
        eq(storedObject.id, id),
        eq(storedObject.userId, userId),
        eq(storedObject.purpose, purpose.name),
        isNull(storedObject.releasedAt),
      ));
      if (!row) return null;
      if (!row.confirmedAt) {
        if (!await storedAsReserved(storage, purpose, row.objectKey, row)) return null;
        await database.update(storedObject).set({ confirmedAt: now() }).where(eq(storedObject.id, id));
      }
      return { id: row.id, contentType: row.contentType, byteLength: row.byteLength };
    },

    /** A short-lived link to a confirmed object of this user's, or `null`. */
    async viewUrl(userId: string, purpose: UserStoragePurpose, id: string) {
      if (!storage) return null;
      const [row] = await database.select({ objectKey: storedObject.objectKey }).from(storedObject).where(and(
        eq(storedObject.id, id),
        eq(storedObject.userId, userId),
        eq(storedObject.purpose, purpose.name),
        isNotNull(storedObject.confirmedAt),
        isNull(storedObject.releasedAt),
      ));
      return row ? storage.presignDownload(row.objectKey, purpose.viewSeconds) : null;
    },

    /** Marks objects for deletion; pass the caller's transaction so the release commits with whatever stopped using them. */
    async release(ids: string[], executor: Executor = database) {
      if (ids.length === 0) return;
      await executor.update(storedObject).set({ releasedAt: now() })
        .where(and(inArray(storedObject.id, ids), isNull(storedObject.releasedAt)));
    },

    /**
     * Deletes objects that should no longer exist, then their rows: released,
     * owned by a deleted account, or never confirmed. A failed deletion keeps
     * its row for next time.
     */
    async purge(batch = 200) {
      if (!storage) return { deleted: 0, failed: 0 };
      const unconfirmedBefore = new Date(now().getTime() - UNCONFIRMED_SECONDS * 1_000);
      const due = await database.select({ id: storedObject.id, objectKey: storedObject.objectKey })
        .from(storedObject)
        .where(or(
          isNotNull(storedObject.releasedAt),
          isNull(storedObject.userId),
          and(isNull(storedObject.confirmedAt), lt(storedObject.createdAt, unconfirmedBefore)),
        ))
        .limit(batch);
      let deleted = 0;
      let failed = 0;
      for (const row of due) {
        try {
          await storage.delete(row.objectKey);
          await database.delete(storedObject).where(eq(storedObject.id, row.id));
          deleted += 1;
        } catch {
          failed += 1;
        }
      }
      return { deleted, failed };
    },
  };
}

export const userObjects = createUserObjectStore(db, objectStorage);
