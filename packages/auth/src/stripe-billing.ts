import {
  billingIntervals,
  paidPlans,
  type BillingCatalog,
  type BillingInterval,
} from "@northwind/billing";
import { stripeSecretMode } from "@northwind/env/stripe";
import { stripe } from "@better-auth/stripe";
import Stripe from "stripe";

import { serverAnalytics } from "./analytics";

const STRIPE_API_VERSION = "2026-10-28.endive" as const;
const CATALOG_TTL_MS = 5 * 60 * 1_000;

export type StripeBillingEnvironment = {
  NODE_ENV?: string;
  /** production (default) runs on Live keys only; staging on test keys only, so it can never charge anyone. */
  DEPLOY_STAGE?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PRICE_PRO_MONTHLY?: string;
  STRIPE_PRICE_PRO_YEARLY?: string;
};

type ConfiguredStripeBilling = {
  configured: true;
  livemode: boolean;
  secretKey: string;
  webhookSecret: string;
  priceIds: Record<BillingInterval, string>;
};

export type StripeBillingConfiguration =
  | { configured: false }
  | ConfiguredStripeBilling;

export type StripeBillingService = {
  configured: boolean;
  livemode: boolean | null;
  plugin: ReturnType<typeof stripe> | null;
  getCatalog: () => Promise<BillingCatalog>;
  cancelSubscriptionAtPeriodEnd: (stripeSubscriptionId: string) => Promise<void>;
};

const environmentKeys = [
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PRICE_PRO_MONTHLY",
  "STRIPE_PRICE_PRO_YEARLY",
] as const;

export function resolveStripeBillingConfiguration(
  environment: StripeBillingEnvironment,
): StripeBillingConfiguration {
  const values = Object.fromEntries(
    environmentKeys.map((key) => [key, environment[key]?.trim() || undefined]),
  ) as Record<(typeof environmentKeys)[number], string | undefined>;
  const configuredKeys = environmentKeys.filter((key) => values[key]);

  if (configuredKeys.length === 0) return { configured: false };

  const missing = environmentKeys.filter((key) => !values[key]);
  if (missing.length > 0) {
    throw new Error(`Incomplete Stripe billing configuration; missing ${missing.join(", ")}`);
  }

  const secretKey = values.STRIPE_SECRET_KEY!;
  const webhookSecret = values.STRIPE_WEBHOOK_SECRET!;
  const priceIds = {
    month: values.STRIPE_PRICE_PRO_MONTHLY!,
    year: values.STRIPE_PRICE_PRO_YEARLY!,
  };

  const secretMode = stripeSecretMode(secretKey);
  if (!secretMode) {
    throw new Error(
      "STRIPE_SECRET_KEY must be a Stripe secret, restricted, or claimable sandbox API key",
    );
  }
  if (environment.NODE_ENV === "production") {
    if (environment.DEPLOY_STAGE === "staging") {
      if (secretMode === "live") throw new Error("Staging billing requires a Stripe test or sandbox key, never a Live key");
    } else if (secretMode !== "live") {
      throw new Error("Production billing requires a Stripe Live secret key");
    }
  }
  if (!webhookSecret.startsWith("whsec_")) {
    throw new Error("STRIPE_WEBHOOK_SECRET must be a Stripe endpoint signing secret");
  }
  for (const [interval, priceId] of Object.entries(priceIds)) {
    if (!priceId.startsWith("price_")) {
      throw new Error(`Stripe ${interval} billing price must start with price_`);
    }
  }
  return {
    configured: true,
    livemode: secretMode === "live",
    secretKey,
    webhookSecret,
    priceIds,
  };
}

type CatalogPrice = Pick<
  Stripe.Price,
  "active" | "currency" | "id" | "product" | "recurring" | "type" | "unit_amount"
>;

export function buildBillingCatalog(
  prices: Record<BillingInterval, CatalogPrice>,
): BillingCatalog {
  const productIds = new Set<string>();
  const unitAmounts = {} as Record<BillingInterval, number>;

  for (const interval of billingIntervals) {
    const price = prices[interval];
    const productId =
      typeof price.product === "string" ? price.product : price.product.id;

    if (!price.active || price.type !== "recurring" || !price.recurring) {
      throw new Error(`Stripe ${interval} price must be an active recurring price`);
    }
    if (price.recurring.interval !== interval || price.recurring.interval_count !== 1) {
      throw new Error(`Stripe ${interval} price has a mismatched recurring interval`);
    }
    if (price.unit_amount === null || price.unit_amount <= 0) {
      throw new Error(`Stripe ${interval} price must have a positive fixed unit amount`);
    }
    if (price.currency !== "usd") {
      throw new Error(`Stripe ${interval} price must use USD`);
    }

    productIds.add(productId);
    unitAmounts[interval] = price.unit_amount;
  }

  if (productIds.size !== 1) {
    throw new Error("Stripe monthly and yearly prices must belong to one product");
  }
  return {
    configured: true,
    unitAmounts,
  };
}

export function createStripeBilling(
  environment: StripeBillingEnvironment,
): StripeBillingService {
  const configuration = resolveStripeBillingConfiguration(environment);

  if (!configuration.configured) {
    return {
      configured: false as const,
      livemode: null,
      plugin: null,
      getCatalog: async (): Promise<BillingCatalog> => ({ configured: false }),
      // Callers gate on `configured`; this stub keeps the service total.
      cancelSubscriptionAtPeriodEnd: async (): Promise<void> => {
        throw new Error("Stripe billing is not configured");
      },
    };
  }

  const stripeClient = new Stripe(configuration.secretKey, {
    apiVersion: STRIPE_API_VERSION,
    maxNetworkRetries: 2,
    timeout: 20_000,
  });
  const plans = billingIntervals.map((interval) => ({
    name: paidPlans[interval].id,
    priceId: configuration.priceIds[interval],
  }));
  const plugin = stripe({
    stripeClient,
    stripeWebhookSecret: configuration.webhookSecret,
    subscription: {
      enabled: true,
      plans,
      ...serverAnalytics.subscriptionCallbacks,
    },
  });

  let cachedCatalog: { expiresAt: number; value: BillingCatalog } | null = null;
  let pendingCatalog: Promise<BillingCatalog> | null = null;

  const loadCatalog = async (): Promise<BillingCatalog> => {
    const [month, year] = await Promise.all([
      stripeClient.prices.retrieve(configuration.priceIds.month),
      stripeClient.prices.retrieve(configuration.priceIds.year),
    ]);
    return buildBillingCatalog({ month, year });
  };

  return {
    configured: true as const,
    livemode: configuration.livemode,
    plugin,
    async cancelSubscriptionAtPeriodEnd(
      stripeSubscriptionId: string,
    ): Promise<void> {
      await stripeClient.subscriptions.update(stripeSubscriptionId, {
        cancel_at_period_end: true,
      });
    },
    async getCatalog(): Promise<BillingCatalog> {
      const now = Date.now();
      if (cachedCatalog && cachedCatalog.expiresAt > now) return cachedCatalog.value;
      if (pendingCatalog) return pendingCatalog;

      pendingCatalog = loadCatalog()
        .then((value) => {
          cachedCatalog = { value, expiresAt: Date.now() + CATALOG_TTL_MS };
          return value;
        })
        .finally(() => {
          pendingCatalog = null;
        });
      return pendingCatalog;
    },
  };
}
