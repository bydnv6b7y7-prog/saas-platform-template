import { summarizeBillingStatus, type UserBillingStatus } from "@northwind/billing";
import { db } from "@northwind/db";
import { subscription } from "@northwind/db/schema/auth";
import { eq } from "drizzle-orm";

import type { StripeBillingService } from "./stripe-billing";

export async function getUserBillingStatus(
  userId: string,
  billing: Pick<StripeBillingService, "configured">,
): Promise<UserBillingStatus> {
  const rows = await db
    .select({
      plan: subscription.plan,
      status: subscription.status,
      stripeSubscriptionId: subscription.stripeSubscriptionId,
      billingInterval: subscription.billingInterval,
      periodEnd: subscription.periodEnd,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    })
    .from(subscription)
    .where(eq(subscription.referenceId, userId));

  return summarizeBillingStatus(rows, billing.configured);
}
