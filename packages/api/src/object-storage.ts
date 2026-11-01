import { env } from "@northwind/env/server";
import { resolveObjectStorageConfig, type ObjectStorageConfiguration } from "@northwind/env/object-storage";
import { AwsClient } from "aws4fetch";

/**
 * The one bucket every upload purpose shares (docs/object-storage.md). Clients
 * upload straight to it with a presigned link; the service only signs, checks,
 * shows and deletes, and never holds object bytes beyond a short prefix.
 */
export interface ObjectStorage {
  /** A link for one object: PUT only, this type, this length, `expiresIn` seconds. */
  presignUpload(key: string, object: { contentType: string; byteLength: number }, expiresIn: number): Promise<{ url: string; headers: Record<string, string> }>;
  /** Size and type of a stored object, or `null` when there is none. */
  head(key: string): Promise<{ size: number; contentType: string | null } | null>;
  /** The object's first `count` bytes, or `null` when there is none. */
  readPrefix(key: string, count: number): Promise<Uint8Array | null>;
  /** A link that shows the object for `expiresIn` seconds. */
  presignDownload(key: string, expiresIn: number): Promise<string>;
  /** Removes the object; removing one that is already gone succeeds. */
  delete(key: string): Promise<void>;
}

/**
 * What one kind of upload may be. Each purpose files its objects under its own
 * prefix, so a bucket lifecycle rule or a manual clean-up can target one kind.
 */
export type StoragePurpose = {
  name: string;
  /** Accepted types, each with the bytes a real file of that type starts with. */
  types: Record<string, { extension: string; magic: number[] }>;
  maxBytes: number;
  uploadSeconds: number;
  viewSeconds: number;
};

export const IMAGE_TYPES = {
  "image/jpeg": { extension: "jpg", magic: [0xff, 0xd8, 0xff] },
  "image/png": { extension: "png", magic: [0x89, 0x50, 0x4e, 0x47] },
  "application/pdf": { extension: "pdf", magic: [0x25, 0x50, 0x44, 0x46] },
} satisfies StoragePurpose["types"];

/** `<purpose>/<environment>/<yyyy-mm>/<id>.<ext>`; the environment keeps development and production apart in one bucket. */
export function objectKey(purpose: StoragePurpose, input: { id: string; contentType: string; at: Date; environment?: string }) {
  const type = purpose.types[input.contentType];
  if (!type) throw new Error(`${purpose.name} does not accept ${input.contentType}`);
  return `${purpose.name}/${input.environment ?? env.NODE_ENV}/${input.at.toISOString().slice(0, 7)}/${input.id}.${type.extension}`;
}

/** Why an upload request is refused before anything is signed, or `null` when it may proceed. */
export function uploadProblem(purpose: StoragePurpose, input: { contentType: string; byteLength: number }): "type" | "size" | null {
  if (!Object.hasOwn(purpose.types, input.contentType)) return "type";
  if (!Number.isInteger(input.byteLength) || input.byteLength < 1 || input.byteLength > purpose.maxBytes) return "size";
  return null;
}

/** The stored object is what was reserved: present, the same size and type, and its bytes start like that type. */
export async function storedAsReserved(storage: ObjectStorage, purpose: StoragePurpose, key: string, reserved: { contentType: string; byteLength: number }) {
  const type = purpose.types[reserved.contentType];
  if (!type) return false;
  const stored = await storage.head(key);
  if (!stored || stored.size !== reserved.byteLength || stored.size > purpose.maxBytes) return false;
  if (stored.contentType !== null && stored.contentType !== reserved.contentType) return false;
  const prefix = await storage.readPrefix(key, type.magic.length);
  return prefix !== null && type.magic.every((byte, index) => prefix[index] === byte);
}

class ObjectStorageError extends Error {
  constructor(operation: string, readonly status: number) {
    super(`Object storage ${operation} failed with ${status}`);
    this.name = "ObjectStorageError";
  }
}

export function createObjectStorage(config: Extract<ObjectStorageConfiguration, { configured: true }>): ObjectStorage {
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
    async presignUpload(key, object, expiresIn) {
      const headers = { "Content-Type": object.contentType, "Content-Length": String(object.byteLength) };
      return { url: await presign(key, expiresIn, { method: "PUT", headers }), headers };
    },
    async head(key) {
      const response = await client.fetch(objectUrl(key).toString(), { method: "HEAD" });
      if (response.status === 404) return null;
      if (!response.ok) throw new ObjectStorageError("head", response.status);
      return { size: Number(response.headers.get("content-length") ?? "-1"), contentType: response.headers.get("content-type") };
    },
    async readPrefix(key, count) {
      const response = await client.fetch(objectUrl(key).toString(), { headers: { Range: `bytes=0-${count - 1}` } });
      if (response.status === 404) return null;
      if (!response.ok) throw new ObjectStorageError("read", response.status);
      return new Uint8Array(await response.arrayBuffer()).slice(0, count);
    },
    async presignDownload(key, expiresIn) {
      return presign(key, expiresIn);
    },
    async delete(key) {
      const response = await client.fetch(objectUrl(key).toString(), { method: "DELETE" });
      // S3 answers 204 whether or not the object existed.
      if (!response.ok && response.status !== 404) throw new ObjectStorageError("delete", response.status);
    },
  };
}

const configuration = resolveObjectStorageConfig(env);

/** The configured store, or `null` when none is set up and uploads are off. */
export const objectStorage: ObjectStorage | null =
  configuration.configured ? createObjectStorage(configuration) : null;
