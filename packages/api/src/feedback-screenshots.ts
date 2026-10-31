import { env } from "@northwind/env/server";
import { resolveFeedbackStorageConfig, type FeedbackStorageConfiguration } from "@northwind/env/feedback-storage";
import { AwsClient } from "aws4fetch";

/**
 * Where feedback screenshots are kept (docs/app-feedback-rating.md). The app
 * uploads straight to the store with a presigned link; this service only signs,
 * checks, shows and deletes. Nothing here holds image bytes except the first
 * three, which say whether an object is a JPEG.
 */
export interface FeedbackScreenshotStorage {
  /** A single-use-ish link for one object: PUT only, this type, this length, `expiresIn` seconds. */
  presignUpload(key: string, byteLength: number, expiresIn: number): Promise<{ url: string; headers: Record<string, string> }>;
  /** Size and type of a stored object, or `null` when there is none. */
  head(key: string): Promise<{ size: number; contentType: string | null } | null>;
  /** The object's first `count` bytes, or `null` when there is none. */
  readPrefix(key: string, count: number): Promise<Uint8Array | null>;
  /** A link that shows the object for `expiresIn` seconds. */
  presignDownload(key: string, expiresIn: number): Promise<string>;
  /** Removes the object; removing one that is already gone succeeds. */
  delete(key: string): Promise<void>;
}

export const SCREENSHOT_UPLOAD_SECONDS = 600;
export const SCREENSHOT_VIEW_SECONDS = 600;

class FeedbackStorageError extends Error {
  constructor(operation: string, readonly status: number) {
    super(`R2 ${operation} failed with ${status}`);
    this.name = "FeedbackStorageError";
  }
}

export function createR2Storage(config: Extract<FeedbackStorageConfiguration, { configured: true }>): FeedbackScreenshotStorage {
  const client = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: "s3",
    region: config.region,
  });
  const objectUrl = (key: string) =>
    new URL(`${config.endpoint}/${encodeURIComponent(config.bucket)}/${key.split("/").map(encodeURIComponent).join("/")}`);
  const presign = async (key: string, expiresIn: number, init: RequestInit = {}) => {
    const url = objectUrl(key);
    url.searchParams.set("X-Amz-Expires", String(expiresIn));
    // `allHeaders` signs Content-Type and Content-Length too, which aws4fetch
    // otherwise leaves out, so the upload has to be exactly what was asked for.
    const signed = await client.sign(new Request(url.toString(), init), { aws: { signQuery: true, allHeaders: true } });
    return signed.url;
  };

  return {
    async presignUpload(key, byteLength, expiresIn) {
      const headers = { "Content-Type": "image/jpeg", "Content-Length": String(byteLength) };
      return { url: await presign(key, expiresIn, { method: "PUT", headers }), headers };
    },
    async head(key) {
      const response = await client.fetch(objectUrl(key).toString(), { method: "HEAD" });
      if (response.status === 404) return null;
      if (!response.ok) throw new FeedbackStorageError("head", response.status);
      return { size: Number(response.headers.get("content-length") ?? "-1"), contentType: response.headers.get("content-type") };
    },
    async readPrefix(key, count) {
      const response = await client.fetch(objectUrl(key).toString(), { headers: { Range: `bytes=0-${count - 1}` } });
      if (response.status === 404) return null;
      if (!response.ok) throw new FeedbackStorageError("read", response.status);
      return new Uint8Array(await response.arrayBuffer()).slice(0, count);
    },
    async presignDownload(key, expiresIn) {
      return presign(key, expiresIn);
    },
    async delete(key) {
      const response = await client.fetch(objectUrl(key).toString(), { method: "DELETE" });
      // S3 answers 204 whether or not the object existed.
      if (!response.ok && response.status !== 404) throw new FeedbackStorageError("delete", response.status);
    },
  };
}

const configuration = resolveFeedbackStorageConfig(env);

/** The configured store, or `null` when R2 is not set up and screenshots are off. */
export const feedbackScreenshotStorage: FeedbackScreenshotStorage | null =
  configuration.configured ? createR2Storage(configuration) : null;
