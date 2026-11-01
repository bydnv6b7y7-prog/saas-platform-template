import { env } from "@northwind/env/web";
import { Link, useLocation } from "@tanstack/react-router";

import { BrandMark } from "@/components/brand-mark";
import { productFooterLinks, productHome } from "@/product";

export function LegalPage({ title, summary, effectiveDate = "August 18, 2026", children }: { title: string; summary: string; effectiveDate?: string; children: React.ReactNode }) {
  const currentHref = useLocation({
    select: (location) => location.href.split("#", 1)[0]!,
  });
  return (
    <div className="min-h-svh">
      <a href="#main-content" className="skip-link">Skip to content</a>
      <header className="border-b border-border/70">
        <div className="mx-auto flex h-16 max-w-3xl items-center justify-between px-4 sm:px-6">
          <Link to={productHome.to} className="flex min-h-11 items-center rounded-xl text-[17px] font-semibold tracking-[-0.02em] outline-none focus-visible:ring-2 focus-visible:ring-ring/40"><BrandMark className="mr-2 size-6" />{env.VITE_BRAND_NAME}</Link>
          <Link to="/login" search={{ redirect: currentHref }} className="inline-flex min-h-11 items-center text-sm font-medium text-brand">Sign in</Link>
        </div>
      </header>
      <main id="main-content" className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
        <p className="text-sm font-medium text-brand">Legal and data</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-[-0.04em] sm:text-5xl">{title}</h1>
        <p className="mt-4 max-w-2xl text-base leading-7 text-muted-foreground">{summary}</p>
        <p className="mt-3 text-xs text-muted-foreground">Effective {effectiveDate}</p>
        <div className="mt-10 space-y-8 text-[15px] leading-7 [&_h2]:text-xl [&_h2]:font-semibold [&_p]:mt-2 [&_ul]:mt-2 [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5">{children}</div>
      </main>
      <footer className="mx-auto flex max-w-3xl flex-wrap gap-x-5 border-t border-border/70 px-4 py-6 text-sm text-muted-foreground sm:px-6">
        <Link to={productHome.to} className="inline-flex min-h-11 items-center">{productHome.label}</Link><Link to="/pricing" className="inline-flex min-h-11 items-center">Pricing</Link><Link to="/terms" className="inline-flex min-h-11 items-center">Terms</Link><Link to="/privacy" className="inline-flex min-h-11 items-center">Privacy</Link><Link to="/privacy" hash="analytics-controls" className="inline-flex min-h-11 items-center">Privacy choices</Link>{productFooterLinks.map(({ to, label }) => <Link key={to} to={to} className="inline-flex min-h-11 items-center">{label}</Link>)}
      </footer>
    </div>
  );
}
