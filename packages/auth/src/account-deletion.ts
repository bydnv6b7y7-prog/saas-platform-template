import type { BetterAuthPlugin } from "better-auth";
import { deleteSessionCookie } from "better-auth/cookies";
import { APIError, createAuthEndpoint, sessionMiddleware } from "better-auth/api";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { createHash } from "node:crypto";
import { z } from "zod";

import { db } from "@northwind/db";
import { subscription, user, verification } from "@northwind/db/schema/auth";
import { usageBuckets } from "@northwind/db/schema/usage";
import type { PostHogDeletionConfiguration } from "@northwind/env/posthog";

import type { SendEmail } from "./email";
import type { StripeBillingService } from "./stripe-billing";

/**
 * Self-service account deletion (App Store guideline 5.1.1(v)) and the shared
 * routine behind admin removal. The user-row delete is the only atomic commit
 * point; every external side effect (Stripe, conversations, PostHog, email)
 * is best-effort so cleanup failures never keep a deleted account alive.
 */

export type DeletedAccountFacts = {
  userId: string;
  stripeCancelled: string[];
  stripeCancelFailures: string[];
  posthogDeletionRequested: boolean;
  conversationCleanup: "done" | "skipped" | "failed";
  emailSent: boolean;
};

export type AccountDeletionDeps = {
  stripe: Pick<StripeBillingService, "configured" | "cancelSubscriptionAtPeriodEnd">;
  sendEmail: SendEmail | null;
  secret: string;
  deletePostHogPerson: ((distinctId: string) => Promise<void>) | null;
  /** Overrides the shared database client (isolated test databases). */
  db?: AccountDeletionDatabase;
};

export type AccountDeletionService = {
  deleteUserAccount: (userId: string) => Promise<DeletedAccountFacts>;
  plugin: BetterAuthPlugin;
};

/**
 * Structural subset of the drizzle client (bun-sql and node-postgres
 * instances differ only in generic query-result typing).
 */
export type AccountDeletionDatabase = Pick<
  typeof db,
  "select" | "delete" | "transaction"
>;

export class AccountDeletionError extends Error {
  readonly code = "USER_NOT_FOUND";

  constructor(userId: string) {
    super(`User ${userId} does not exist.`);
    this.name = "AccountDeletionError";
  }
}

type ConversationHooks = {
  deleteConversationHistory: (userId: string) => Promise<void>;
};

// Registered by the server process (apps/server); mirrors appStoreBilling.onEvent.
let conversationHooks: ConversationHooks | undefined;

export function registerAccountDeletionHooks(hooks: ConversationHooks): void {
  conversationHooks = hooks;
}

/**
 * Pseudonymous usage subject hash. Kept byte-identical to
 * packages/api/src/usage.ts `privacyHash`; packages/auth may not import
 * packages/api (scripts/check-platform-boundaries.ts).
 */
export function usageSubjectHash(userId: string, secret: string): string {
  return createHash("sha256").update(`${secret}:${userId}`).digest("hex");
}

export function verificationIdentifiersForEmail(email: string): string[] {
  const identity = createHash("sha256").update(email).digest("hex");
  return [
    `email-verification-otp-${email}`,
    `northwind:email-otp:operation:${identity}`,
    `northwind:email-otp:cooldown:${identity}`,
  ];
}

const ACTIVE_STRIPE_STATUSES = ["active", "trialing", "past_due"] as const;

function log(
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, unknown> = {},
): void {
  const line = JSON.stringify({ level, event, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}

export function createPostHogPersonDeleter(
  configuration: Extract<PostHogDeletionConfiguration, { configured: true }>,
  request: (url: string, init: RequestInit) => Promise<Response> = globalThis.fetch,
): (distinctId: string) => Promise<void> {
  return async (distinctId) => {
    const response = await request(
      `${configuration.host}/api/environments/${configuration.projectId}/persons/bulk/delete/`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${configuration.personalApiKey}`,
          "Content-Type": "application/json",
        },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({
          distinct_ids: [distinctId],
          delete_events: true,
          delete_recordings: false,
        }),
      },
    );
    if (!response.ok) {
      throw new Error(`PostHog person deletion failed with ${response.status}`);
    }
  };
}

function deletionEmail(email: string) {
  const subject = "Your Northwind account has been deleted";
  const text = `Your Northwind account (${email}) has been deleted, along with your profile, sign-in credentials, sessions, assistant conversation history, saved validations, private queries, share links, and usage counters.\n\nBilling records we must keep for finance and compliance are retained in anonymized form.\n\nIf you paid with a card, your subscription has been cancelled at the end of the current billing period and will not renew. If you subscribed on iPhone or iPad, Apple manages that subscription — cancel it in App Store > Subscriptions; we cannot cancel it for you.\n\nIf you did not request this deletion, contact support immediately.`;
  const html = `<h1>Your account has been deleted</h1><p>Your Northwind account (<strong>${email}</strong>) has been deleted, along with your profile, sign-in credentials, sessions, assistant conversation history, saved validations, private queries, share links, and usage counters.</p><p>Billing records we must keep for finance and compliance are retained in anonymized form.</p><p><strong>Card subscriptions:</strong> cancelled at the end of the current billing period; they will not renew.</p><p><strong>iPhone/iPad subscriptions:</strong> Apple manages those — cancel them in App Store &gt; Subscriptions; we cannot cancel them for you.</p><p>If you did not request this deletion, contact support immediately.</p>`;
  return { to: email, subject, text, html };
}

export function createAccountDeletion(deps: AccountDeletionDeps): AccountDeletionService {
  const database = deps.db ?? db;

  async function deleteUserAccount(userId: string): Promise<DeletedAccountFacts> {
    const [account] = await database
      .select({ id: user.id, email: user.email })
      .from(user)
      .where(eq(user.id, userId));
    if (!account) throw new AccountDeletionError(userId);

    const facts: DeletedAccountFacts = {
      userId,
      stripeCancelled: [],
      stripeCancelFailures: [],
      posthogDeletionRequested: false,
      conversationCleanup: "skipped",
      emailSent: false,
    };

    // 1. Stripe: cancel active card subscriptions at period end, best-effort.
    if (deps.stripe.configured) {
      const activeSubscriptions = await database
        .select({ stripeSubscriptionId: subscription.stripeSubscriptionId })
        .from(subscription)
        .where(
          and(
            eq(subscription.referenceId, userId),
            isNotNull(subscription.stripeSubscriptionId),
            eq(subscription.cancelAtPeriodEnd, false),
            inArray(subscription.status, [...ACTIVE_STRIPE_STATUSES]),
          ),
        );
      for (const { stripeSubscriptionId } of activeSubscriptions) {
        try {
          await deps.stripe.cancelSubscriptionAtPeriodEnd(stripeSubscriptionId!);
          facts.stripeCancelled.push(stripeSubscriptionId!);
        } catch (error) {
          // Never block deletion; the ledger row is retained for reconciliation.
          facts.stripeCancelFailures.push(stripeSubscriptionId!);
          log("error", "account_deletion.stripe_cancel_failed", {
            error: { errorName: error instanceof Error ? error.name : "UnknownError" },
          });
        }
      }
    }

    // 2. Assistant conversation history, best-effort (hook registered by the server).
    if (conversationHooks) {
      try {
        await conversationHooks.deleteConversationHistory(userId);
        facts.conversationCleanup = "done";
      } catch (error) {
        facts.conversationCleanup = "failed";
        log("error", "account_deletion.conversation_cleanup_failed", {
          error: { errorName: error instanceof Error ? error.name : "UnknownError" },
        });
      }
    } else {
      log("warn", "account_deletion.conversation_hook_missing");
    }

    // 3. PostHog person, best-effort.
    if (deps.deletePostHogPerson) {
      try {
        await deps.deletePostHogPerson(userId);
        facts.posthogDeletionRequested = true;
      } catch (error) {
        log("error", "account_deletion.posthog_deletion_failed", {
          error: { errorName: error instanceof Error ? error.name : "UnknownError" },
        });
      }
    }

    // 4. Database: the only atomic commit point.
    await database.transaction(async (tx) => {
      await tx
        .delete(verification)
        .where(inArray(verification.identifier, verificationIdentifiersForEmail(account.email)));
      await tx
        .delete(usageBuckets)
        .where(eq(usageBuckets.subjectHash, usageSubjectHash(userId, deps.secret)));
      const deleted = await tx.delete(user).where(eq(user.id, userId)).returning({ id: user.id });
      if (deleted.length === 0) throw new AccountDeletionError(userId);
    });

    // 5. Confirmation email, best-effort, after the account is really gone.
    if (deps.sendEmail) {
      try {
        await deps.sendEmail(deletionEmail(account.email));
        facts.emailSent = true;
      } catch {
        log("error", "account_deletion.email_send_failed");
      }
    }

    log("info", "account_deletion.completed", {
      stripeCancelled: facts.stripeCancelled.length,
      stripeCancelFailures: facts.stripeCancelFailures.length,
      posthogDeletionRequested: facts.posthogDeletionRequested,
      conversationCleanup: facts.conversationCleanup,
      emailSent: facts.emailSent,
    });
    return facts;
  }

  const plugin = {
    id: "account-deletion",
    version: "0.1.0",
    endpoints: {
      deleteAccount: createAuthEndpoint(
        "/account/delete",
        {
          method: "POST",
          // The typed email is UX confirmation; the server re-validates it
          // against the session so the gate is not client-only.
          body: z
            .object({
              email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
            })
            .strict(),
          use: [sessionMiddleware],
        },
        async (ctx) => {
          ctx.setHeader("Cache-Control", "no-store");
          if (ctx.body.email !== ctx.context.session.user.email.toLowerCase()) {
            throw new APIError("BAD_REQUEST", {
              code: "EMAIL_CONFIRMATION_MISMATCH",
              message: "The email you entered does not match this account.",
            });
          }
          try {
            await deleteUserAccount(ctx.context.session.user.id);
          } catch (error) {
            if (error instanceof AccountDeletionError) {
              throw new APIError("NOT_FOUND", {
                code: "USER_NOT_FOUND",
                message: "Account not found.",
              });
            }
            throw error;
          }
          deleteSessionCookie(ctx);
          return ctx.json({ success: true });
        },
      ),
    },
  } satisfies BetterAuthPlugin;

  return { deleteUserAccount, plugin };
}
