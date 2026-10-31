import { z } from "zod";

export const billingIntervals = ["month", "year"] as const;

export const assistantPlans = ["free", "pro"] as const;

export const accessSources = ["free", "subscription", "admin"] as const;

export type AssistantPlan = (typeof assistantPlans)[number];

export type AccessSource = (typeof accessSources)[number];

export const assistantUsageStatusSchema = z.object({
  plan: z.enum(assistantPlans),
  accessSource: z.enum(accessSources).default("free"),
  // Kept for already-loaded clients during a rolling deploy. History is not an entitlement.
  historyEnabled: z.boolean(),
  limits: z.object({
    per5Minutes: z.number().int().positive(),
    perDay: z.number().int().positive(),
  }),
  daily: z.object({
    used: z.number().int().nonnegative(),
    remaining: z.number().int().nonnegative(),
    resetAt: z.iso.datetime(),
  }),
});

export type AssistantUsageStatus = z.infer<typeof assistantUsageStatusSchema>;

export type BillingInterval = (typeof billingIntervals)[number];

export const paidPlans = {
  month: {
    id: "pro-monthly",
    label: "Monthly",
  },
  year: {
    id: "pro-yearly",
    label: "Yearly",
  },
} as const satisfies Record<
  BillingInterval,
  { id: string; label: string }
>;

export const billingCatalogSchema = z.discriminatedUnion("configured", [
  z.object({ configured: z.literal(false) }),
  z.object({
    configured: z.literal(true),
    unitAmounts: z.object({
      month: z.number().int().nonnegative(),
      year: z.number().int().nonnegative(),
    }),
  }),
]);

export type BillingCatalog = z.infer<typeof billingCatalogSchema>;

export const userBillingStatusSchema = z.object({
  configured: z.boolean(),
  accessSource: z.enum(accessSources).default("free"),
  subscription: z
    .object({
      plan: z.string(),
      status: z.string(),
      interval: z.enum(billingIntervals).nullable(),
      periodEnd: z.iso.datetime().nullable(),
      cancelAtPeriodEnd: z.boolean(),
      grantsAccess: z.boolean(),
      needsAttention: z.boolean(),
    })
    .nullable(),
});

export type UserBillingStatus = z.infer<typeof userBillingStatusSchema>;

export type SubscriptionSnapshot = {
  plan: string;
  status: string;
  stripeSubscriptionId?: string | null;
  billingInterval?: string | null;
  periodEnd?: Date | string | null;
  cancelAtPeriodEnd?: boolean | null;
};

const entitlementStatuses = new Set(["active", "trialing"]);
const terminalStatuses = new Set(["canceled", "incomplete_expired"]);

export function getBillingIntervalForPlan(planId: string): BillingInterval | null {
  for (const interval of billingIntervals) {
    if (paidPlans[interval].id === planId) return interval;
  }
  return null;
}

export function formatUsdAmount(unitAmount: number): string {
  const amount = unitAmount / 100;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    maximumFractionDigits: Number.isInteger(amount) ? 0 : 2,
  }).format(amount);
}

export function annualBillingComparison(
  monthlyUnitAmount: number,
  yearlyUnitAmount: number,
) {
  const fullYearUnitAmount = monthlyUnitAmount * 12;
  const savingsUnitAmount = Math.max(0, fullYearUnitAmount - yearlyUnitAmount);
  return {
    monthlyEquivalentUnitAmount: yearlyUnitAmount / 12,
    savingsUnitAmount,
    savingsPercent:
      fullYearUnitAmount > 0
        ? Math.round((savingsUnitAmount / fullYearUnitAmount) * 100)
        : 0,
  };
}

export function planLabel(plan: string): string {
  return Object.values(paidPlans).find((candidate) => candidate.id === plan)?.label ?? "Pro";
}

export function grantsPaidAccess(subscription: SubscriptionSnapshot): boolean {
  return (
    entitlementStatuses.has(subscription.status) &&
    getBillingIntervalForPlan(subscription.plan) !== null
  );
}

export function canStartCheckout(status: UserBillingStatus): boolean {
  return (
    status.accessSource !== "admin" &&
    status.configured &&
    status.subscription === null
  );
}

export function withAdminAccess(status: UserBillingStatus): UserBillingStatus {
  return { ...status, accessSource: "admin" };
}

export function summarizeBillingStatus(
  subscriptions: readonly SubscriptionSnapshot[],
  configured = true,
): UserBillingStatus {
  const current = subscriptions
    .filter(isManagedSubscription)
    .sort((left, right) => {
      return (
        statusPriority(left.status) - statusPriority(right.status) ||
        dateValue(right.periodEnd) - dateValue(left.periodEnd)
      );
    })[0];

  if (!current) {
    return { configured, accessSource: "free", subscription: null };
  }

  const declaredInterval = billingIntervals.find(
    (interval) => interval === current.billingInterval,
  );
  const grantsAccess = grantsPaidAccess(current);
  return {
    configured,
    accessSource: grantsAccess ? "subscription" : "free",
    subscription: {
      plan: current.plan,
      status: current.status,
      interval: getBillingIntervalForPlan(current.plan) ?? declaredInterval ?? null,
      periodEnd: toIsoDate(current.periodEnd),
      cancelAtPeriodEnd: current.cancelAtPeriodEnd === true,
      grantsAccess,
      needsAttention: !grantsAccess,
    },
  };
}

function isManagedSubscription(subscription: SubscriptionSnapshot): boolean {
  if (terminalStatuses.has(subscription.status)) return false;

  // Better Auth creates this local row before it creates a Stripe Checkout
  // Session. With no Stripe subscription behind it, an abandoned Checkout is
  // safe to retry and cannot be managed in the Stripe customer portal.
  return subscription.status !== "incomplete" || Boolean(subscription.stripeSubscriptionId);
}

function statusPriority(status: string): number {
  if (status === "active") return 0;
  if (status === "trialing") return 1;
  return 2;
}

function toIsoDate(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function dateValue(value: Date | string | null | undefined): number {
  if (!value) return 0;
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}
