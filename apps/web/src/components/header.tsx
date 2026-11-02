import { Button, buttonVariants } from "@northwind/ui/components/button";
import { Link, useLocation } from "@tanstack/react-router";
import { CircleUserRound, CreditCard, LoaderCircle, ShieldCheck } from "lucide-react";
import { lazy, Suspense } from "react";

import { env } from "@northwind/env/web";
import type { AppUser, SessionStatus } from "@/components/app-shell";
import { BrandMark } from "@/components/brand-mark";
import { productAdminHome, productHome, productNavLinks } from "@/product";

const UserMenu = lazy(() => import("./user-menu"));

const links = [
  ...productNavLinks,
  { to: "/pricing", label: "Pricing", icon: CreditCard },
] as const;

type HeaderProps = {
  user: AppUser | null;
  isAdmin: boolean;
  sessionStatus?: SessionStatus;
};

export default function Header({
  user,
  isAdmin,
  sessionStatus,
}: HeaderProps) {
  const currentHref = useLocation({
    select: (location) => location.href.split("#", 1)[0]!,
  });
  const redirectTarget =
    currentHref.startsWith("/") && !currentHref.startsWith("//")
      ? currentHref.slice(0, 300)
      : productHome.to;
  const navigationLinks = isAdmin
    ? [
        ...links,
        {
          to: productAdminHome,
          label: "Admin",
          icon: ShieldCheck,
        } as const,
      ]
    : links;
  const mobileGridClass =
    navigationLinks.length >= 4
      ? "grid-cols-4"
      : navigationLinks.length === 3
        ? "grid-cols-3"
        : "grid-cols-2";

  return (
    <>
      <header className="app-chrome sticky top-0 z-40 border-b border-border/70">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
          <Link
            to={productHome.to}
            className="flex min-h-11 items-center rounded-xl text-[17px] font-semibold tracking-[-0.02em] outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            <BrandMark className="mr-2 size-6" />
            {env.VITE_BRAND_NAME}
          </Link>

          <nav aria-label="Primary" className="hidden items-center gap-1 md:flex">
            {navigationLinks.map(({ to, label }) => (
              <Link
                key={to}
                to={to}
                className="flex h-11 items-center rounded-xl px-4 text-sm font-medium transition-colors hover:bg-muted/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                activeProps={{ className: "bg-brand/10 text-brand" }}
                inactiveProps={{ className: "text-muted-foreground" }}
              >
                {label}
              </Link>
            ))}
          </nav>

          <div className="flex items-center">
            {user ? (
              <Suspense
                fallback={
                  <span role="status" className="grid size-11 place-items-center rounded-xl text-muted-foreground">
                    <CircleUserRound className="size-5" aria-hidden="true" />
                    <span className="sr-only">Loading account menu</span>
                  </span>
                }
              >
                <UserMenu user={user} isAdmin={isAdmin} />
              </Suspense>
            ) : sessionStatus?.isPending ? (
              <span role="status" className="grid size-11 place-items-center text-muted-foreground">
                <LoaderCircle className="size-5 animate-spin" aria-hidden="true" />
                <span className="sr-only">Checking sign-in status</span>
              </span>
            ) : sessionStatus?.error ? (
              <Button variant="outline" onClick={sessionStatus.retry}>
                Retry account
              </Button>
            ) : (
              <Link
                to="/login"
                search={{ redirect: redirectTarget }}
                className={buttonVariants({ variant: "outline" })}
              >
                Sign in
              </Link>
            )}
          </div>
        </div>
      </header>

      <nav
        aria-label="Primary"
        className={`app-chrome fixed inset-x-0 bottom-0 z-50 grid border-t border-border/70 px-2 pb-[env(safe-area-inset-bottom)] md:hidden ${mobileGridClass}`}
      >
        {navigationLinks.map(({ to, label, icon: Icon }) => (
          <Link
            key={to}
            to={to}
            className="group flex min-h-16 flex-col items-center justify-center gap-1 rounded-xl text-[11px] font-medium outline-none transition-colors active:bg-muted/70 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40"
            activeProps={{ className: "bg-brand/10 text-brand" }}
            inactiveProps={{ className: "text-muted-foreground" }}
          >
            <Icon className="size-5" strokeWidth={1.9} aria-hidden="true" />
            {label}
            <span
              className="h-0.5 w-5 rounded-full bg-transparent transition-colors group-data-[status=active]:bg-brand"
              aria-hidden="true"
            />
          </Link>
        ))}
      </nav>
    </>
  );
}
