import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { FeedbackScreenshotStorage } from "@northwind/api/feedback-screenshots";

// The real bucket, only when asked: APP_FEEDBACK_R2_TEST=1 with R2_* set
// (docs/app-feedback-rating.md, failure modes 20–27). It writes a few small
// objects under app-feedback-test/ and deletes them. Nothing is imported until
// then, so a normal test run never loads storage or the server env from here.
const enabled = process.env.APP_FEEDBACK_R2_TEST === "1";

(enabled ? describe : describe.skip)("feedback screenshots in the real R2 bucket", () => {
  let storage: FeedbackScreenshotStorage;
  beforeAll(async () => {
    const { resolveFeedbackStorageConfig } = await import("@northwind/env/feedback-storage");
    const { createR2Storage } = await import("@northwind/api/feedback-screenshots");
    const config = resolveFeedbackStorageConfig(process.env);
    if (!config.configured) throw new Error("APP_FEEDBACK_R2_TEST=1 needs R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET and R2_ENDPOINT");
    storage = createR2Storage(config);
  });
  const keys: string[] = [];
  const key = () => {
    const value = `app-feedback-test/${crypto.randomUUID()}.jpg`;
    keys.push(value);
    return value;
  };
  const jpeg = (length: number) => {
    const bytes = new Uint8Array(length).fill(0x11);
    bytes.set([0xff, 0xd8, 0xff, 0xe0]);
    return bytes;
  };
  const put = (url: string, body: Uint8Array, headers: Record<string, string>) =>
    fetch(url, { method: "PUT", body, headers }).then((response) => response.status);

  afterAll(async () => {
    for (const each of keys) await storage.delete(each);
    for (const each of keys) expect(await storage.head(each)).toBeNull();
  });

  test("an upload link takes exactly the signed type and length, for that one object", async () => {
    const target = key();
    const bytes = jpeg(2_048);
    const ticket = await storage.presignUpload(target, bytes.length, 600);
    expect(new URL(ticket.url).searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;content-type;host");
    expect(new URL(ticket.url).searchParams.get("X-Amz-Expires")).toBe("600");
    expect(ticket.url).not.toContain(process.env.R2_SECRET_ACCESS_KEY!);
    expect(await put(ticket.url, jpeg(4_096), { "Content-Type": "image/jpeg", "Content-Length": "4096" })).toBe(403);
    expect(await put(ticket.url, bytes, { "Content-Type": "image/png", "Content-Length": "2048" })).toBe(403);
    const elsewhere = new URL(ticket.url);
    elsewhere.pathname = elsewhere.pathname.replace(/[^/]+$/, "elsewhere.jpg");
    expect(await put(elsewhere.toString(), bytes, ticket.headers)).toBe(403);
    expect(await storage.head(target)).toBeNull();

    expect(await put(ticket.url, bytes, ticket.headers)).toBe(200);
    expect(await storage.head(target)).toEqual({ size: 2_048, contentType: "image/jpeg" });
    expect(Array.from((await storage.readPrefix(target, 3))!)).toEqual([0xff, 0xd8, 0xff]);
  }, 30_000);

  test("an expired link is refused", async () => {
    const target = key();
    const ticket = await storage.presignUpload(target, 16, 1);
    await Bun.sleep(2_100);
    expect(await put(ticket.url, jpeg(16), ticket.headers)).toBe(403);
    expect(await storage.head(target)).toBeNull();
  }, 30_000);

  test("a view link shows the object; deleting is final and repeatable", async () => {
    const target = key();
    const ticket = await storage.presignUpload(target, 512, 600);
    expect(await put(ticket.url, jpeg(512), ticket.headers)).toBe(200);
    const view = await fetch(await storage.presignDownload(target, 600));
    expect(view.status).toBe(200);
    expect(view.headers.get("content-type")).toBe("image/jpeg");
    expect((await view.arrayBuffer()).byteLength).toBe(512);
    await storage.delete(target);
    expect(await storage.head(target)).toBeNull();
    expect(await storage.readPrefix(target, 3)).toBeNull();
    expect((await fetch(await storage.presignDownload(target, 600))).status).toBe(404);
    await storage.delete(target);
  }, 30_000);
});
