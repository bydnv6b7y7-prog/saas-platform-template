import {
  annualBillingComparison,
  billingIntervals,
  formatUsdAmount,
  paidPlans,
  type BillingInterval,
} from "@northwind/billing";
import { Button, buttonVariants } from "@northwind/ui/components/button";
import { Card } from "@northwind/ui/components/card";
import { Skeleton } from "@northwind/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { ArrowRight, Check, RefreshCw, ShieldCheck, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import {
  billingCatalogQueryOptions,
  billingStatusQueryOptions,
  getCheckoutURLs,
} from "@/lib/billing";
import { authClient } from "@/lib/auth-client";
import { captureAnalytics } from "@/lib/analytics";
import { createSeoHead } from "@/lib/seo";
import { productHome, productPricing } from "@/product";
import { assistantName, brandName } from "@/lib/brand";

export const Route = createFileRoute("/pricing")({
  component: PricingPage,
  validateSearch: (search: Record<string, unknown>): { interval?: BillingInterval } => ({
    ...(billingIntervals.includes(search.interval as BillingInterval)
      ? { interval: search.interval as BillingInterval }
      : {}),
  }),
  head: () =>
    createSeoHead({
      title: "Pricing",
      description: productPricing.description,
      path: "/pricing",
    }),
  loader: async ({ context }) => {
    await context.queryClient.prefetchQuery(billingCatalogQueryOptions());
  },
});

const freeFeatures = productPricing.freeFeatures;

const proFeatures = [
  "Everything in Free",
  `100 ${assistantName} requests per day`,
] as const;

function FeatureList({ features }: { features: readonly string[] }) {
  return (
    <ul className="mt-7 space-y-3 text-sm">
      {features.map((feature) => (
        <li key={feature} className="flex items-start gap-2.5">
          <Check className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden="true" />
          <span>{feature}</span>
        </li>
      ))}
    </ul>
  );
}

function PricingPage() {
  const navigate = Route.useNavigate();
  const search = Route.useSearch();
  const session = authClient.useSession();
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  // Better Auth does not have a server session snapshot on this public SSR route.
  // Hold all session-derived UI until hydration so the first client render exactly
  // matches the server HTML instead of forcing React to rebuild the pricing page.
  const sessionPending = !hydrated || session.isPending;
  const userId = hydrated ? session.data?.user.id : undefined;
  const catalog = useQuery(billingCatalogQueryOptions());
  const billingStatus = useQuery(billingStatusQueryOptions(userId));
  const currentSubscription = billingStatus.data?.subscription ?? null;
  const hasAdminAccess = billingStatus.data?.accessSource === "admin";
  const currentInterval = currentSubscription?.interval ?? null;
  const selectedInterval = search.interval ?? currentInterval ?? "year";
  const [checkoutPending, setCheckoutPending] = useState(false);

  const configuredCatalog = catalog.data?.configured ? catalog.data : null;
  const selectedUnitAmount = configuredCatalog?.unitAmounts[selectedInterval];
  const annualComparison = configuredCatalog
    ? annualBillingComparison(
        configuredCatalog.unitAmounts.month,
        configuredCatalog.unitAmounts.year,
      )
    : null;
  const displayUnitAmount =
    selectedInterval === "year" && annualComparison
      ? annualComparison.monthlyEquivalentUnitAmount
      : selectedUnitAmount;
  const planStatusPending = Boolean(userId) && billingStatus.isLoading;
  const planActionDisabled =
    checkoutPending ||
    sessionPending ||
    planStatusPending ||
    (Boolean(userId) && billingStatus.isError) ||
    (!currentSubscription &&
      (!configuredCatalog || billingStatus.data?.configured === false));

  const handlePlanAction = async () => {
    if (sessionPending) return;
    if (!userId) {
      await navigate({
        to: "/login",
        search: { redirect: `/pricing?interval=${selectedInterval}` },
      });
      return;
    }
    if (!billingStatus.data || billingStatus.isError) {
      toast.error("Confirm your subscription status before starting checkout");
      return;
    }
    if (currentSubscription) {
      await navigate({ to: "/account/billing" });
      return;
    }
    if (hasAdminAccess) return;
    if (!billingStatus.data.configured) {
      toast.error("Billing is not available in this environment");
      return;
    }
    if (selectedUnitAmount === undefined) {
      toast.error("The selected price is temporarily unavailable");
      return;
    }

    const plan = paidPlans[selectedInterval];
    captureAnalytics(
      "billing_checkout_started",
      {
        billing_interval: selectedInterval,
        currency: "USD",
        list_price_minor: selectedUnitAmount,
        plan: plan.id,
      },
      { send_instantly: true, transport: "sendBeacon" },
    );
    setCheckoutPending(true);
    try {
      const { error } = await authClient.subscription.upgrade({
        plan: plan.id,
        ...getCheckoutURLs(selectedInterval),
      });
      if (error) throw new Error(error.message || "Checkout could not be started");
    } catch (error) {
      captureAnalytics("billing_checkout_failed", {
        billing_interval: selectedInterval,
        failure_kind: error instanceof Error ? "request_error" : "unknown",
        plan: plan.id,
      });
      toast.error(error instanceof Error ? error.message : "Checkout could not be started");
      setCheckoutPending(false);
    }
  };

  return (
    <div className="page-shell max-w-6xl">
      <section className="mx-auto max-w-3xl text-center">
        <p className="text-sm font-medium text-brand">Simple, transparent pricing</p>
        <h1 className="mt-3 text-4xl font-semibold tracking-[-0.05em] sm:text-6xl">
          {productPricing.title}
        </h1>
        <p className="mx-auto mt-5 max-w-2xl text-base leading-7 text-muted-foreground sm:text-lg">
          {productPricing.headline}
        </p>
      </section>

      {userId && billingStatus.isError ? (
        <Card className="mx-auto mt-8 max-w-3xl flex-row items-center justify-between gap-4 p-4">
          <div>
            <p className="text-sm font-medium">Your subscription status could not be checked.</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Checkout is paused to prevent a duplicate subscription.
            </p>
          </div>
          <Button variant="outline" onClick={() => void billingStatus.refetch()}>
            <RefreshCw aria-hidden="true" /> Retry
          </Button>
        </Card>
      ) : null}

      {catalog.isLoading ? (
        <div className="mx-auto mt-10 grid max-w-4xl gap-5 md:grid-cols-2">
          <Skeleton className="h-[30rem] rounded-2xl" />
          <Skeleton className="h-[30rem] rounded-2xl" />
        </div>
      ) : (
        <>
          {catalog.isError ? (
            <Card className="mx-auto mt-8 max-w-3xl flex-row items-center justify-between gap-4 p-4">
              <div>
                <p className="font-medium">Pro pricing could not be loaded.</p>
                <p className="text-sm text-muted-foreground">
                  {productPricing.freeFallback}
                </p>
              </div>
              <Button variant="outline" onClick={() => void catalog.refetch()}>
                <RefreshCw aria-hidden="true" /> Retry
              </Button>
            </Card>
          ) : !catalog.data?.configured ? (
            <Card className="mx-auto mt-8 max-w-3xl p-4 text-sm text-muted-foreground">
              Pro checkout is not configured in this environment. {productPricing.freeFallback}
            </Card>
          ) : null}
          <div className="mx-auto mt-10 grid max-w-4xl gap-5 md:grid-cols-2">
            <Card className="justify-between p-6 sm:p-8 md:min-h-[30rem]">
              <div>
                <p className="text-sm font-medium text-muted-foreground">Free</p>
                <div className="mt-5 flex items-end gap-1.5">
                  <span className="text-5xl font-semibold tracking-[-0.05em]">$0</span>
                  <span className="pb-1 text-sm text-muted-foreground">forever</span>
                </div>
                <p className="mt-4 text-sm leading-6 text-muted-foreground">
                  {productPricing.freeSummary}
                </p>
                <FeatureList features={freeFeatures} />
              </div>
              <Link
                to={productHome.to}
                className={buttonVariants({ variant: "outline", className: "mt-8 w-full" })}
              >
                {productPricing.ctaLabel} <ArrowRight aria-hidden="true" />
              </Link>
            </Card>

            <Card className="justify-between border-brand/30 p-6 ring-2 ring-brand/65 sm:p-8 md:min-h-[30rem]">
              <div>
                <div className="flex items-center gap-2">
                  <Sparkles className="size-4 text-brand" aria-hidden="true" />
                  <p className="text-sm font-medium">{brandName} Pro</p>
                  {hasAdminAccess ? (
                    <span className="rounded-full bg-brand/10 px-2 py-0.5 text-xs font-medium text-brand">
                      Admin access
                    </span>
                  ) : null}
                  {currentSubscription?.needsAttention ? (
                    <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-800 dark:text-amber-200">
                      Needs attention
                    </span>
                  ) : null}
                </div>

                <div
                  className="mt-6 grid grid-cols-2 rounded-xl bg-muted/70 p-1"
                  role="group"
                  aria-label="Pro billing interval"
                >
                  {billingIntervals.map((interval) => (
                    <button
                      key={interval}
                      type="button"
                      aria-pressed={selectedInterval === interval}
                      onClick={() => {
                        if (selectedInterval !== interval) {
                          captureAnalytics("billing_interval_selected", {
                            billing_interval: interval,
                          });
                        }
                        void navigate({ search: { interval }, replace: true });
                      }}
                      className="min-h-10 rounded-lg px-3 text-sm font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-sm"
                    >
                      {paidPlans[interval].label}
                      {currentInterval === interval ? (
                        <span className="ml-1 text-xs text-brand">Current</span>
                      ) : interval === "year" && annualComparison?.savingsPercent ? (
                        <span className="ml-1 text-xs text-brand">
                          Save {annualComparison.savingsPercent}%
                        </span>
                      ) : null}
                    </button>
                  ))}
                </div>

                <div className="mt-6 flex items-end gap-1.5">
                  <span className="text-5xl font-semibold tracking-[-0.05em]">
                    {displayUnitAmount !== undefined && configuredCatalog
                      ? formatUsdAmount(displayUnitAmount)
                      : "—"}
                  </span>
                  <span className="pb-1 text-sm text-muted-foreground">/month</span>
                </div>
                <p className="mt-2 min-h-6 text-sm text-muted-foreground">
                  {configuredCatalog && selectedUnitAmount !== undefined
                    ? selectedInterval === "year"
                      ? `${formatUsdAmount(selectedUnitAmount)} billed yearly${
                          annualComparison?.savingsUnitAmount
                            ? ` · Save ${formatUsdAmount(annualComparison.savingsUnitAmount)}`
                            : ""
                        }`
                      : `${formatUsdAmount(selectedUnitAmount)} billed monthly`
                    : "Price unavailable"}
                </p>
                <FeatureList features={proFeatures} />
              </div>

              <div className="mt-8">
                {hasAdminAccess && !currentSubscription ? (
                  <div className="rounded-xl bg-brand/10 px-4 py-3 text-center text-sm font-medium text-brand">
                    Pro access included with your administrator account
                  </div>
                ) : (
                  <Button
                    className="w-full"
                    disabled={planActionDisabled}
                    onClick={() => void handlePlanAction()}
                  >
                    {checkoutPending
                      ? "Opening Stripe…"
                      : sessionPending || planStatusPending
                        ? "Checking plan…"
                        : currentSubscription
                          ? "Manage billing"
                          : "Start Pro"}
                    <ArrowRight aria-hidden="true" />
                  </Button>
                )}
                <p className="mt-3 text-center text-xs leading-5 text-muted-foreground">
                  {hasAdminAccess
                    ? currentSubscription
                      ? "Admin access remains active independently of this subscription. Pro usage limits still apply."
                      : "No Stripe subscription is required. Pro usage limits still apply."
                    : "Usage limits apply. Prices are in USD. Renews automatically until canceled; taxes may apply."}
                </p>
              </div>
            </Card>
          </div>
        </>
      )}

      <div className="mx-auto mt-8 flex max-w-3xl items-start gap-3 rounded-2xl border border-border/70 bg-muted/35 p-4 text-sm leading-6 text-muted-foreground">
        <ShieldCheck className="mt-0.5 size-5 shrink-0 text-brand" aria-hidden="true" />
        <p>
          Payment details go directly to Stripe and are never stored by {brandName}. Manage invoices,
          payment methods, and cancellation from your billing portal.
        </p>
      </div>
    </div>
  );
}
