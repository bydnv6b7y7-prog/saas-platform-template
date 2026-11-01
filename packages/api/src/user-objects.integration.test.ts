import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { applyMigrationsFor, connectTestDatabase } from "@northwind/db/testing";

import { IMAGE_TYPES, type ObjectStorage } from "./object-storage";
import { UploadRefused, createUserObjectStore, type UserStoragePurpose } from "./user-objects";

// A dedicated local database only (scripts/test-postgres.ts creates it fresh).
const url = process.env.USER_OBJECTS_TEST_DATABASE_URL;
if (url) {
  const parsed = new URL(url);
  if (!["127.0.0.1", "localhost"].includes(parsed.hostname) || parsed.pathname !== "/northwind_user_objects_test") {
    throw new Error("USER_OBJECTS_TEST_DATABASE_URL must reference the dedicated local northwind_user_objects_test database");
  }
}

/** Behaves as the S3 stand-in does: a PUT must match the signed type and length. */
class MemoryStorage implements ObjectStorage {
  objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  signed = new Map<string, { contentType: string; byteLength: number }>();
  async presignUpload(key: string, object: { contentType: string; byteLength: number }) {
    this.signed.set(key, object);
    return { url: `memory://${key}`, headers: { "Content-Type": object.contentType, "Content-Length": String(object.byteLength) } };
  }
  put(url: string, bytes: Uint8Array, contentType: string) {
    const key = url.replace("memory://", "");
    const ticket = this.signed.get(key);
    if (!ticket || ticket.byteLength !== bytes.length || ticket.contentType !== contentType) return 403;
    this.objects.set(key, { bytes, contentType });
    return 200;
  }
  async head(key: string) {
    const object = this.objects.get(key);
    return object ? { size: object.bytes.length, contentType: object.contentType } : null;
  }
  async readPrefix(key: string, count: number) { return this.objects.get(key)?.bytes.slice(0, count) ?? null; }
  async presignDownload(key: string) { return `memory://${key}?view`; }
  async delete(key: string) { this.objects.delete(key); }
}

const purpose: UserStoragePurpose = {
  name: "test-attachment",
  types: { "image/png": IMAGE_TYPES["image/png"] },
  maxBytes: 1_000,
  uploadSeconds: 600,
  viewSeconds: 600,
  quota: { free: { objects: 2, bytes: 1_500 }, pro: { objects: 10, bytes: 10_000 } },
};
const png = (length: number) => {
  const bytes = new Uint8Array(length).fill(1);
  bytes.set([0x89, 0x50, 0x4e, 0x47]);
  return bytes;
};

(url ? describe : describe.skip)("user objects / real PostgreSQL", () => {
  let database: ReturnType<typeof connectTestDatabase>;
  let pool: ReturnType<typeof connectTestDatabase>["pool"];
  let storage: MemoryStorage;
  let clock: Date;
  let store: ReturnType<typeof createUserObjectStore>;

  beforeAll(async () => {
    database = connectTestDatabase(url!);
    pool = database.pool;
    await pool.query(`CREATE TABLE "user" (id text PRIMARY KEY)`);
    await applyMigrationsFor(pool, ["stored_object"]);
  });
  afterAll(() => pool.end());
  beforeEach(async () => {
    await pool.query(`TRUNCATE stored_object; DELETE FROM "user"; INSERT INTO "user" VALUES ('alice'), ('bob')`);
    storage = new MemoryStorage();
    clock = new Date("2026-11-01T00:00:00Z");
    store = createUserObjectStore(database.db, storage, () => clock);
  });

  const upload = async (userId: string, length = 100, plan: "free" | "pro" = "free") => {
    const ticket = await store.reserve({ userId, plan, purpose, contentType: "image/png", byteLength: length });
    expect(storage.put(ticket.url, png(length), "image/png")).toBe(200);
    return ticket;
  };
  const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error) => (error as UploadRefused).reason);

  test("type, size and the plan's quota are enforced before anything is signed", async () => {
    expect(await refusal(store.reserve({ userId: "alice", plan: "free", purpose, contentType: "image/gif", byteLength: 10 }))).toBe("type");
    expect(await refusal(store.reserve({ userId: "alice", plan: "free", purpose, contentType: "image/png", byteLength: 1_001 }))).toBe("size");
    await upload("alice", 800);
    expect(await refusal(store.reserve({ userId: "alice", plan: "free", purpose, contentType: "image/png", byteLength: 800 }))).toBe("quota");
    await upload("alice", 100);
    expect(await refusal(store.reserve({ userId: "alice", plan: "free", purpose, contentType: "image/png", byteLength: 1 }))).toBe("quota");
    // Pro has room; another user's quota is their own.
    await upload("alice", 100, "pro");
    await upload("bob", 100);
    expect(await store.usage("alice", purpose, "free")).toEqual({ objects: 3, bytes: 1_000, limit: purpose.quota.free, plan: "free", available: true });
  });

  test("concurrent reservations cannot both slip under the quota", async () => {
    const results = await Promise.allSettled(Array.from({ length: 5 }, () =>
      store.reserve({ userId: "alice", plan: "free", purpose, contentType: "image/png", byteLength: 10 })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
  });

  test("confirm checks the bytes and the owner; only confirmed objects can be viewed", async () => {
    const missing = await store.reserve({ userId: "alice", plan: "free", purpose, contentType: "image/png", byteLength: 100 });
    expect(await store.confirm("alice", purpose, missing.id)).toBeNull();

    const ticket = await upload("alice");
    expect(await store.viewUrl("alice", purpose, ticket.id)).toBeNull();
    expect(await store.confirm("bob", purpose, ticket.id)).toBeNull();
    expect(await store.confirm("alice", { ...purpose, name: "other" }, ticket.id)).toBeNull();
    expect(await store.confirm("alice", purpose, ticket.id)).toEqual({ id: ticket.id, contentType: "image/png", byteLength: 100 });
    expect(await store.viewUrl("alice", purpose, ticket.id)).toStartWith("memory://test-attachment/");
    expect(await store.viewUrl("bob", purpose, ticket.id)).toBeNull();

    // Right type and size, wrong bytes: never confirmed.
    const forged = await store.reserve({ userId: "bob", plan: "free", purpose, contentType: "image/png", byteLength: 4 });
    expect(storage.put(forged.url, new Uint8Array([1, 2, 3, 4]), "image/png")).toBe(200);
    expect(await store.confirm("bob", purpose, forged.id)).toBeNull();
  });

  test("released, orphaned by account deletion, or never confirmed: the clean-up deletes object and row", async () => {
    const kept = await upload("alice", 100, "pro");
    await store.confirm("alice", purpose, kept.id);
    const released = await upload("alice", 100, "pro");
    await store.confirm("alice", purpose, released.id);
    const unconfirmed = await upload("alice", 100, "pro");
    const orphaned = await upload("bob");
    await store.confirm("bob", purpose, orphaned.id);

    await store.release([released.id]);
    expect(await store.viewUrl("alice", purpose, released.id)).toBeNull();
    await pool.query(`DELETE FROM "user" WHERE id = 'bob'`);
    expect((await store.purge()).deleted).toBe(2);
    expect(storage.objects.size).toBe(2);

    clock = new Date(clock.getTime() + 3_600_001);
    expect(await store.purge()).toEqual({ deleted: 1, failed: 0 });
    expect(await store.confirm("alice", purpose, unconfirmed.id)).toBeNull();
    expect([...storage.objects.keys()]).toEqual([expect.stringContaining(kept.id)]);
    expect((await pool.query("SELECT id FROM stored_object")).rows).toEqual([{ id: kept.id }]);
  });
});
