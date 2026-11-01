import { z } from "zod";

/**
 * The one object store every upload purpose shares (docs/object-storage.md):
 * a Cloudflare R2 bucket, or any S3 API, reached with S3 credentials. All four
 * values are set together or none are; with none, uploads are simply off.
 */
type ObjectStorageEnvironment = {
  R2_REGION?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET?: string;
  R2_ENDPOINT?: string;
};

export type ObjectStorageConfiguration =
  | { configured: false }
  | { configured: true; region: string; accessKeyId: string; secretAccessKey: string; bucket: string; endpoint: string };

export const objectStorageEnvSchema = {
  R2_REGION: z.string().trim().min(1).optional(),
  R2_ACCESS_KEY_ID: z.string().trim().min(1).optional(),
  R2_SECRET_ACCESS_KEY: z.string().trim().min(1).optional(),
  R2_BUCKET: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/, "R2 bucket names are 3–63 lowercase letters, digits and hyphens").optional(),
  // The account endpoint, https://<account>.r2.cloudflarestorage.com; the bucket is a path under it.
  // Plain HTTP is accepted only for a local S3 stand-in (docker compose --profile e2e).
  R2_ENDPOINT: z.url({ protocol: /^https?$/ }).refine(
    (value) => value.startsWith("https://") || ["localhost", "127.0.0.1"].includes(new URL(value).hostname),
    "R2_ENDPOINT must use HTTPS (HTTP only for localhost)",
  ).optional(),
};

export function resolveObjectStorageConfig(environment: ObjectStorageEnvironment): ObjectStorageConfiguration {
  const values = {
    accessKeyId: environment.R2_ACCESS_KEY_ID?.trim() || undefined,
    secretAccessKey: environment.R2_SECRET_ACCESS_KEY?.trim() || undefined,
    bucket: environment.R2_BUCKET?.trim() || undefined,
    endpoint: environment.R2_ENDPOINT?.trim() || undefined,
  };
  const present = Object.values(values).filter(Boolean).length;
  if (present === 0) return { configured: false };
  if (present < 4) {
    throw new Error("Incomplete R2 configuration; R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET and R2_ENDPOINT must be set together");
  }
  return {
    configured: true,
    region: environment.R2_REGION?.trim() || "auto",
    accessKeyId: values.accessKeyId!,
    secretAccessKey: values.secretAccessKey!,
    bucket: values.bucket!,
    endpoint: values.endpoint!.replace(/\/+$/, ""),
  };
}
