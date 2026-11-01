#!/usr/bin/env bun
/**
 * Lets the web app upload straight to the bucket (docs/object-storage.md): the
 * bucket must answer the browser's CORS preflight for the web origin. One rule
 * set, applied to R2 in production and to the local S3 stand-in alike.
 *
 *   bun run storage:cors            # apps/server/.env: R2_* and CORS_ORIGIN
 *   bun run storage:cors --deploy   # .env.dokploy.local: R2_* and VITE_WEB_URL
 */
import { AwsClient } from "aws4fetch";
import dotenv from "dotenv";
import { existsSync, readFileSync } from "node:fs";

export type Bucket = { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string; region: string };

/** PUT for uploads, GET and HEAD for signed views; Content-Length is set by the browser and never asked for. */
export function corsRules(origin: string) {
  return [{ AllowedOrigins: [new URL(origin).origin], AllowedMethods: ["PUT", "GET", "HEAD"], AllowedHeaders: ["content-type"], MaxAgeSeconds: 3600 }];
}

export function corsXml(origin: string) {
  const rules = corsRules(origin).map((rule) => [
    "<CORSRule>",
    ...rule.AllowedOrigins.map((value) => `<AllowedOrigin>${value}</AllowedOrigin>`),
    ...rule.AllowedMethods.map((value) => `<AllowedMethod>${value}</AllowedMethod>`),
    ...rule.AllowedHeaders.map((value) => `<AllowedHeader>${value}</AllowedHeader>`),
    `<MaxAgeSeconds>${rule.MaxAgeSeconds}</MaxAgeSeconds>`,
    "</CORSRule>",
  ].join(""));
  return `<CORSConfiguration>${rules.join("")}</CORSConfiguration>`;
}

const bucketUrl = (bucket: Pick<Bucket, "endpoint" | "bucket">) => `${bucket.endpoint.replace(/\/+$/, "")}/${encodeURIComponent(bucket.bucket)}`;

/** Writes the rules with the S3 PutBucketCors call; returns the HTTP status. */
export async function applyCors(bucket: Bucket, origin: string): Promise<number> {
  const client = new AwsClient({ ...bucket, service: "s3" });
  const body = corsXml(origin);
  const md5 = new Bun.CryptoHasher("md5").update(body).digest("base64");
  const response = await client.fetch(`${bucketUrl(bucket)}?cors`, {
    method: "PUT",
    body,
    headers: { "Content-Type": "application/xml", "Content-MD5": md5 },
  });
  return response.status;
}

/** What a browser on `origin` sends before a presigned PUT: true when the bucket would let it through. */
export async function preflight(bucket: Pick<Bucket, "endpoint" | "bucket">, origin: string): Promise<boolean> {
  const response = await fetch(`${bucketUrl(bucket)}/cors-preflight-probe`, {
    method: "OPTIONS",
    headers: { Origin: new URL(origin).origin, "Access-Control-Request-Method": "PUT", "Access-Control-Request-Headers": "content-type" },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  return response?.ok === true && response.headers.get("access-control-allow-origin") === new URL(origin).origin;
}

if (import.meta.main) {
  const deploy = process.argv.includes("--deploy");
  const file = new URL(deploy ? "../.env.dokploy.local" : "../apps/server/.env", import.meta.url).pathname;
  const env = existsSync(file) ? dotenv.parse(readFileSync(file, "utf8")) : {};
  const origin = deploy ? env.VITE_WEB_URL : env.CORS_ORIGIN;
  const missing = ["R2_ENDPOINT", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"].filter((key) => !env[key]?.trim());
  if (missing.length || !origin) {
    console.error(`${file}: set ${[...missing, ...(origin ? [] : [deploy ? "VITE_WEB_URL" : "CORS_ORIGIN"])].join(", ")} first`);
    process.exit(2);
  }
  const bucket: Bucket = {
    endpoint: env.R2_ENDPOINT!, bucket: env.R2_BUCKET!, accessKeyId: env.R2_ACCESS_KEY_ID!, secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
    region: env.R2_REGION || "auto",
  };
  const status = await applyCors(bucket, origin);
  if (status !== 200) {
    console.error(`The bucket refused the CORS rules (${status}). An object-only token cannot change bucket settings:`);
    console.error(`paste these into Cloudflare → R2 → ${bucket.bucket} → Settings → CORS policy, or use a token with admin rights:\n`);
    console.error(JSON.stringify(corsRules(origin), null, 2));
    process.exit(1);
  }
  const passes = await preflight(bucket, origin);
  console.log(passes
    ? `✓ ${bucket.bucket} accepts browser uploads from ${new URL(origin).origin}`
    : `✗ rules written, but a preflight from ${new URL(origin).origin} is still refused (R2 can take a minute to apply them; rerun bun run doctor)`);
  process.exit(passes ? 0 : 1);
}
