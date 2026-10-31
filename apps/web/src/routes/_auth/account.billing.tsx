import { formatUsdAmount, paidPlans, planLabel } from "@northwind/billing";
import { Button } from "@northwind/ui/components/button";
import { Card } from "@northwind/ui/components/card";
import { Skeleton } from "@northwind/ui/components/skeleton";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import {
  ArrowRight,
  CalendarClock,
  CreditCard,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { getAbsoluteAppURL } from "@/lib/app-url";
import { authClient } from "@/lib/auth-client";
import {
  billingCatalogQueryOptions,
  billingStatusQueryKey,
  billingStatusQueryOptions,
} from "@/lib/billing";
import { productHome, productPricing } from "@/product";

export const Route = createFileRoute("/_auth/account/billing")({
  component: AccountBillingPage,
  validateSearch: (search: Record<string, unknown>): { checkout?: "success" } => ({
    ...(search.checkout === "success" ? { checkout: "success" as const } : {}),
  }),
});

function AccountBillingPage() {
  const { user } = Route.useRouteContext();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  const userId = user.id;
  const billingStatus = useQuery(billingStatusQueryOptions(userId));
  const catalog = useQuery(billingCatalogQueryOptions());
  const currentSubscription = billingStatus.data?.subscription ?? null;
  const hasAdminAccess = billingStatus.data?.accessSource === "admin";
  const [openingPortal, setOpeningPortal] = useState(false);

  useEffect(() => {
    if (search.checkout !== "success") return;
    toast.success("Checkout completed");
    void queryClient.invalidateQueries({ queryKey: billingStatusQueryKey(userId) });
    void navigate({ to: "/account/billing", search: {}, replace: true });
  }, [navigate, queryClient, search.checkout, userId]);

  const openPortal = async () => {
    setOpeningPortal(true);
    try {
      const { error } = await authClient.subscription.billingPortal({
        returnUrl: getAbsoluteAppURL("/account/billing"),
      });
      if (error) throw new Error(error.message || "Billing portal could not be opened");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Billing portal could not be opened");
      setOpeningPortal(false);
    }
  };

  const interval = currentSubscription?.interval ?? null;
  const priceDetail =
    interval && catalog.data?.configured
      ? ` · ${formatUsdAmount(catalog.data.unitAmounts[interval])}/${interval}`
      : "";

  return (
    <div className="page-shell max-w-4xl">
      <header className="mb-7">
        <p className="text-sm font-medium text-brand">Account</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-[-0.04em] sm:text-5xl">
          Plan &amp; billing
        </h1>
        <p className="mt-3 max-w-2xl text-base leading-7 text-muted-foreground">
          Review product access and billing details here. Stripe&apos;s customer portal manages any
          paid subscription, including payment methods, invoices, and cancellation.
        </p>
      </header>

      {billingStatus.isLoading ? (
        <Skeleton className="h-64 rounded-2xl" />
      ) : billingStatus.isError ? (
        <Card className="items-center p-8 text-center">
          <p className="font-medium">Subscription status could not be loaded.</p>
          <p className="text-sm text-muted-foreground">Your Stripe subscription is unchanged.</p>
          <Button variant="outline" onClick={() => void billingStatus.refetch()}>
            <RefreshCw aria-hidden="true" /> Retry
          </Button>
        </Card>
      ) : currentSubscription ? (
        <Card className="p-6 sm:p-8">
          <div className="flex flex-wrap items-start justify-between gap-5">
            <div>
              <div className="flex items-center gap-2">
                <CreditCard className="size-5 text-brand" aria-hidden="true" />
                <h2 className="text-xl font-semibold tracking-tight">Northwind Pro</h2>
              </div>
              <p className="mt-2 text-sm text-muted-foreground">
                {planLabel(currentSubscription.plan)} billing{priceDetail}
              </p>
            </div>
            <span
              className={`rounded-full px-3 py-1 text-xs font-medium capitalize ${
                currentSubscription.needsAttention
                  ? "bg-amber-500/10 text-amber-800 dark:text-amber-200"
                  : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
              }`}
            >
              {currentSubscription.status.replaceAll("_", " ")}
            </span>
          </div>

          <div className="mt-7 grid gap-4 border-y border-border/70 py-6 sm:grid-cols-2">
            <div>
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Billing interval
              </p>
              <p className="mt-1 font-medium">{interval ? paidPlans[interval].label : "Pro"}</p>
            </div>
            <div>
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                {currentSubscription.cancelAtPeriodEnd ? "Access through" : "Next renewal"}
              </p>
              <p className="mt-1 flex items-center gap-2 font-medium">
                <CalendarClock className="size-4 text-muted-foreground" aria-hidden="true" />
                {currentSubscription.periodEnd
                  ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(
                      new Date(currentSubscription.periodEnd),
                    )
                  : "Pending Stripe confirmation"}
              </p>
            </div>
          </div>

          {currentSubscription.needsAttention ? (
            <p className="mt-5 rounded-xl bg-amber-500/10 p-4 text-sm leading-6 text-amber-900 dark:text-amber-200">
              This subscription does not currently grant Pro access. Open the Stripe portal to
              review it; a second checkout is intentionally disabled.
            </p>
          ) : currentSubscription.cancelAtPeriodEnd ? (
            <p className="mt-5 rounded-xl bg-amber-500/10 p-4 text-sm leading-6 text-amber-900 dark:text-amber-200">
              Cancellation is scheduled. Pro access continues until the end of the current billing
              period; you can restore it from the Stripe portal before then.
            </p>
          ) : null}

          {hasAdminAccess ? (
            <p className="mt-5 rounded-xl bg-brand/10 p-4 text-sm leading-6 text-foreground">
              Administrator access remains active independently of this subscription. You can
              cancel the subscription without losing internal Pro access.
            </p>
          ) : null}

          <div className="mt-6 flex flex-wrap gap-3">
            <Button
              disabled={openingPortal || billingStatus.data?.configured === false}
              onClick={() => void openPortal()}
            >
              {openingPortal ? "Opening Stripe…" : "Manage billing"}
              <ArrowRight aria-hidden="true" />
            </Button>
            <Link
              to="/pricing"
              className="inline-flex min-h-11 items-center px-2 text-sm font-medium text-muted-foreground hover:text-foreground"
            >
              Compare plans
            </Link>
          </div>
        </Card>
      ) : hasAdminAccess ? (
        <Card className="items-start p-6 sm:p-8">
          <ShieldCheck className="size-6 text-brand" aria-hidden="true" />
          <div>
            <h2 className="text-lg font-semibold">Admin access</h2>
            <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
              Your administrator account includes Pro-level product access. No Stripe
              subscription or payment method is required, and normal Pro usage limits still
              apply.
            </p>
          </div>
          <Link
            to={productHome.to}
            className="inline-flex h-11 items-center gap-2 rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/80"
          >
            {productPricing.ctaLabel} <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
        </Card>
      ) : (
        <Card className="items-start p-6 sm:p-8">
          <CreditCard className="size-6 text-brand" aria-hidden="true" />
          <div>
            <h2 className="text-lg font-semibold">No active subscription</h2>
            <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
              {productPricing.freeFallback} Choose monthly or yearly Pro billing for a higher
              daily AI allowance.
            </p>
          </div>
          <Link
            to="/pricing"
            className="inline-flex h-11 items-center gap-2 rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/80"
          >
            Compare plans <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
        </Card>
      )}
    </div>
  );
}
