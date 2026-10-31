import { env } from "@northwind/env/web";
import { Button, buttonVariants } from "@northwind/ui/components/button";
import { Card } from "@northwind/ui/components/card";
import { Link } from "@tanstack/react-router";
import { Compass, RefreshCw, ServerCrash } from "lucide-react";
import { productHome } from "@/product";

export function RouteErrorState({ reset }: { reset: () => void }) {
  return (
    <>
      <title>{`Temporarily unavailable | ${env.VITE_BRAND_NAME}`}</title>
      <div className="page-shell max-w-3xl">
        <Card className="items-center p-8 text-center sm:p-12">
          <span className="grid size-12 place-items-center rounded-2xl bg-muted text-muted-foreground">
            <ServerCrash className="size-6" aria-hidden="true" />
          </span>
          <p className="text-sm font-medium text-brand">Temporary interruption</p>
          <h1 className="text-2xl font-semibold tracking-[-0.03em] sm:text-3xl">
            We couldn’t load this view
          </h1>
          <p className="max-w-xl text-sm leading-6 text-muted-foreground">
            Nothing was changed. Retry the request or return to {productHome.label}.
          </p>
          <div className="mt-2 flex flex-wrap justify-center gap-2">
            <Button onClick={reset} data-icon="inline-start">
              <RefreshCw aria-hidden="true" /> Retry
            </Button>
            <Link to={productHome.to} className={buttonVariants({ variant: "outline" })}>
              {productHome.label}
            </Link>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            If this continues, contact support and include the page address and time of the
            attempt.
          </p>
        </Card>
      </div>
    </>
  );
}

export function RouteNotFoundState() {
  return (
    <>
      <title>{`Page Not Found | ${env.VITE_BRAND_NAME}`}</title>
      <div className="page-shell max-w-3xl">
        <Card className="items-center p-8 text-center sm:p-12">
          <span className="grid size-12 place-items-center rounded-2xl bg-muted text-muted-foreground">
            <Compass className="size-6" aria-hidden="true" />
          </span>
          <p className="text-sm font-medium text-brand">404 · Page not found</p>
          <h1 className="text-2xl font-semibold tracking-[-0.03em] sm:text-3xl">
            This page isn’t in the observed map
          </h1>
          <p className="max-w-xl text-sm leading-6 text-muted-foreground">
            The address may be outdated or incomplete.
          </p>
          <div className="mt-2 flex flex-wrap justify-center gap-2">
            <Link to={productHome.to} className={buttonVariants()}>
              {productHome.label}
            </Link>
          </div>
        </Card>
      </div>
    </>
  );
}
