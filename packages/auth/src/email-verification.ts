import {
  EMAIL_VERIFICATION_ALLOWED_ATTEMPTS,
  EMAIL_VERIFICATION_EXPIRES_IN_SECONDS,
  EMAIL_VERIFICATION_OTP_LENGTH,
  EMAIL_VERIFICATION_RESEND_INTERVAL_SECONDS,
} from "@northwind/env/email";
import type { BetterAuthOptions } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { emailOTP } from "better-auth/plugins/email-otp";
import { createHash } from "node:crypto";
import { z } from "zod";

import type { SendEmail } from "./email";
import { BRAND_NAME, IDENTIFIER_PREFIX } from "@northwind/env/brand";

const sendPath = "/email-otp/send-verification-otp";
const verifyPath = "/email-otp/verify-email";
const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));
type Context = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];
type Lease = { identifier: string; value: string };
type PolicyContext = Context["context"] & { emailVerificationLease?: Lease };

function tooManyRequests(seconds: number) {
  throw new APIError("TOO_MANY_REQUESTS", {
    code: "EMAIL_VERIFICATION_RATE_LIMITED",
    message: "Please wait before trying again.",
  }, { "X-Retry-After": String(Math.max(1, seconds)) });
}

// Better Auth 1.7.2 reserves a deterministic primary key in the existing
// verification table. PostgreSQL arbitrates requests across API replicas.
async function reserve(ctx: Context, identifier: string, seconds: number) {
  const adapter = ctx.context.internalAdapter;
  const existing = await adapter.findVerificationValue(identifier);
  const now = Date.now();
  if (existing && existing.expiresAt.getTime() > now) {
    tooManyRequests(Math.ceil((existing.expiresAt.getTime() - now) / 1_000));
  }
  if (existing) await ctx.context.adapter.deleteMany({
    model: "verification",
    where: [{ field: "id", value: existing.id }, { field: "expiresAt", operator: "lte", value: new Date(now) }],
  });
  const value = crypto.randomUUID();
  if (!await adapter.reserveVerificationValue({ identifier, value, expiresAt: new Date(now + seconds * 1_000) })) {
    tooManyRequests(seconds);
  }
  return { identifier, value };
}

async function release(ctx: Context, lease: Lease) {
  await ctx.context.adapter.deleteMany({ model: "verification", where: [
    { field: "identifier", value: lease.identifier }, { field: "value", value: lease.value },
  ] });
}

export function createEmailVerificationOptions(sendEmail: SendEmail) {
  const otp = emailOTP({
    otpLength: EMAIL_VERIFICATION_OTP_LENGTH,
    expiresIn: EMAIL_VERIFICATION_EXPIRES_IN_SECONDS,
    allowedAttempts: EMAIL_VERIFICATION_ALLOWED_ATTEMPTS,
    storeOTP: "encrypted",
    resendStrategy: "rotate",
    disableSignUp: true,
    sendVerificationOnSignUp: false,
    async sendVerificationOTP({ email, otp: code, type }) {
      if (type !== "email-verification") throw new APIError("BAD_REQUEST", { message: "Unsupported verification purpose." });
      try {
        const minutes = EMAIL_VERIFICATION_EXPIRES_IN_SECONDS / 60;
        await sendEmail({
          to: email,
          subject: `Your ${BRAND_NAME} verification code`,
          text: `Your ${BRAND_NAME} verification code is:\n\n${code}\n\nEnter this code in the app or website where you started signing in. This code expires in ${minutes} minutes and can only be used once.\n\nIf you did not request this email, you can ignore it.`,
          html: `<h1>Verify your email</h1><p>Enter this code in the app or website where you started signing in:</p><p style="font-size:32px;font-weight:700;letter-spacing:8px">${code}</p><p>This code expires in ${minutes} minutes and can only be used once.</p><p>If you did not request this email, you can ignore it.</p>`,
        });
      } catch {
        throw new APIError("SERVICE_UNAVAILABLE", { code: "EMAIL_DELIVERY_FAILED", message: "The verification email could not be sent. Please try again shortly." });
      }
    },
  });

  return {
    emailAndPassword: { enabled: true, requireEmailVerification: true },
    emailVerification: { sendOnSignUp: false, sendOnSignIn: false, autoSignInAfterVerification: true },
    // The OTP plugin also provides passwordless login and reset routes. Only
    // email ownership verification is part of this product's contract.
    disabledPaths: [
      "/send-verification-email", "/verify-email", "/sign-in/email-otp",
      "/email-otp/create-verification-otp", "/email-otp/get-verification-otp", "/email-otp/check-verification-otp",
      "/email-otp/request-password-reset", "/email-otp/reset-password", "/forget-password/email-otp",
      "/email-otp/request-email-change", "/email-otp/change-email",
    ],
    plugins: [otp, {
      id: "email-verification-policy",
      hooks: {
        before: [{
          matcher: (ctx) => ctx.path === sendPath || ctx.path === verifyPath,
          handler: createAuthMiddleware(async (ctx) => {
            const parsed = emailSchema.safeParse(ctx.body?.email);
            if (!parsed.success || (ctx.path === sendPath && ctx.body?.type !== "email-verification")) {
              throw new APIError("BAD_REQUEST", { code: "INVALID_EMAIL_VERIFICATION_REQUEST", message: "Invalid verification request." });
            }
            if (ctx.path === verifyPath && !new RegExp(`^[0-9]{${EMAIL_VERIFICATION_OTP_LENGTH}}$`).test(ctx.body?.otp ?? "")) {
              throw new APIError("BAD_REQUEST", { code: "INVALID_OTP", message: "Enter the six-digit code from your email." });
            }
            ctx.body.email = parsed.data;
            const identity = createHash("sha256").update(parsed.data).digest("hex");
            const lease = await reserve(ctx, `${IDENTIFIER_PREFIX}:email-otp:operation:${identity}`, 30);
            try {
              if (ctx.path === sendPath) await reserve(ctx, `${IDENTIFIER_PREFIX}:email-otp:cooldown:${identity}`, EMAIL_VERIFICATION_RESEND_INTERVAL_SECONDS);
              const account = await ctx.context.internalAdapter.findUserByEmail(parsed.data);
              if (!account || account.user.emailVerified) {
                if (ctx.path === verifyPath) throw new APIError("BAD_REQUEST", { code: "INVALID_OTP", message: "This verification code cannot be used. Sign in or request a new code." });
                await release(ctx, lease);
                return ctx.json({ success: true });
              }
              if (ctx.path === sendPath) {
                // The pinned OTP plugin permits non-unique identifiers. Remove
                // all previous codes while holding the per-email operation lease.
                await ctx.context.adapter.deleteMany({ model: "verification", where: [
                  { field: "identifier", value: `email-verification-otp-${parsed.data}` },
                ] });
              }
              return { context: { context: {
                emailVerificationLease: lease,
                // The pinned default runner catches delivery errors. This
                // request must await acceptance and propagate its sanitized 503.
                runInBackgroundOrAwait: async (task: Promise<unknown>) => { await task; },
              } } };
            } catch (error) {
              await release(ctx, lease);
              throw error;
            }
          }),
        }],
        after: [{
          matcher: (ctx) => ctx.path === sendPath || ctx.path === verifyPath,
          handler: createAuthMiddleware(async (ctx) => {
            const lease = (ctx.context as PolicyContext).emailVerificationLease;
            if (lease) await release(ctx, lease);
          }),
        }],
      },
    }],
    rateLimit: { enabled: true, customRules: {
      [sendPath]: { window: EMAIL_VERIFICATION_RESEND_INTERVAL_SECONDS, max: 1 },
      [verifyPath]: { window: 60, max: 10 },
    } },
  } satisfies BetterAuthOptions;
}
