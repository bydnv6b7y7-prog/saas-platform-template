import { z } from "zod";

export const EMAIL_VERIFICATION_EXPIRES_IN_SECONDS = 300;
export const EMAIL_VERIFICATION_RESEND_INTERVAL_SECONDS = 60;
export const EMAIL_VERIFICATION_OTP_LENGTH = 6;
export const EMAIL_VERIFICATION_ALLOWED_ATTEMPTS = 3;

export const cloudflareEmailKeys = [
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_EMAIL_API_TOKEN",
  "EMAIL_FROM",
] as const;

function parseEmailSender(value: string): string | { address: string; name: string } | null {
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;
  const sender = value.trim();
  if (z.email().safeParse(sender).success) return sender;

  const namedSender = /^([^<>"\\,;]+?)\s*<([^<>\s]+)>$/.exec(sender);
  if (!namedSender) return null;
  const name = namedSender[1]!.trim();
  const address = namedSender[2]!;
  if (!name || !z.email().safeParse(address).success) return null;
  return { address, name };
}

export const emailServerSchema = {
  CLOUDFLARE_ACCOUNT_ID: z.string().regex(/^[a-f0-9]{32}$/i).optional(),
  CLOUDFLARE_EMAIL_API_TOKEN: z.string().trim().min(1).regex(/^[^\s]+$/).optional(),
  EMAIL_FROM: z.string().refine((value) => parseEmailSender(value) !== null, {
    message: "Use an email address or Display Name <email@example.com>",
  }).optional(),
  /**
   * Development only: deliver every email to a local Mailpit inbox (http://localhost:8025) instead of
   * Cloudflare, so sign-up works without an email provider. Refused when NODE_ENV=production.
   */
  EMAIL_DEV_MAILPIT_URL: z.url({ protocol: /^https?$/ }).optional(),
};

/** The local Mailpit inbox for development email, or null. Never used in production. */
export function readMailpitConfiguration(environment: Record<string, unknown>): { url: string } | null {
  const value = typeof environment.EMAIL_DEV_MAILPIT_URL === "string" ? environment.EMAIL_DEV_MAILPIT_URL.trim() : "";
  if (!value) return null;
  if (environment.NODE_ENV === "production") {
    throw new Error("EMAIL_DEV_MAILPIT_URL is for local development; remove it from production");
  }
  return { url: emailServerSchema.EMAIL_DEV_MAILPIT_URL.unwrap().parse(value).replace(/\/+$/, "") };
}

export function readCloudflareEmailConfiguration(environment: Record<string, unknown>) {
  const parsed = z.object(emailServerSchema).parse(Object.fromEntries(
    cloudflareEmailKeys.map((key) => [key, environment[key] || undefined]),
  ));
  if (cloudflareEmailKeys.every((key) => !parsed[key])) return null;
  const missing = cloudflareEmailKeys.filter((key) => !parsed[key]);
  if (missing.length > 0) {
    throw new Error(`Incomplete Cloudflare Email configuration; missing ${missing.join(", ")}`);
  }
  return {
    accountId: parsed.CLOUDFLARE_ACCOUNT_ID!,
    apiToken: parsed.CLOUDFLARE_EMAIL_API_TOKEN!,
    from: parseEmailSender(parsed.EMAIL_FROM!)!,
  };
}
