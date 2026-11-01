import {
  billingCatalogSchema,
  type BillingCatalog,
  type BillingInterval,
  userBillingStatusSchema,
  type UserBillingStatus,
} from "@northwind/billing";
import { queryOptions } from "@tanstack/react-query";

import { getAbsoluteAppURL } from "./app-url";
import { getApiBaseURL } from "./api-url";

const billingCatalogQueryKey = ["billing", "catalog"] as const;

export function billingCatalogQueryOptions() {
  return queryOptions({
    queryKey: billingCatalogQueryKey,
    queryFn: async (): Promise<BillingCatalog> => {
      const response = await fetch(`${getApiBaseURL()}/api/billing/catalog`, {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error("Billing catalog is temporarily unavailable");
      return billingCatalogSchema.parse(await response.json());
    },
    staleTime: 5 * 60 * 1_000,
  });
}

export function billingStatusQueryKey(userId: string | undefined) {
  return ["billing", "status", userId ?? "anonymous"] as const;
}

export function billingStatusQueryOptions(userId: string | undefined) {
  return queryOptions({
    queryKey: billingStatusQueryKey(userId),
    enabled: Boolean(userId),
    queryFn: async (): Promise<UserBillingStatus> => {
      const response = await fetch(`${getApiBaseURL()}/api/billing/status`, {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error("Subscription status is temporarily unavailable");
      return userBillingStatusSchema.parse(await response.json());
    },
    staleTime: 30_000,
  });
}

export function getCheckoutURLs(interval: BillingInterval) {
  const pricing = new URL(getAbsoluteAppURL("/pricing"));
  pricing.searchParams.set("interval", interval);
  return {
    successUrl: getAbsoluteAppURL("/account/billing?checkout=success"),
    cancelUrl: pricing.toString(),
    returnUrl: getAbsoluteAppURL("/account/billing"),
  };
}
