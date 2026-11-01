import type { AppRouter } from "@northwind/product/router";
import { env } from "@northwind/env/web";
import { Toaster } from "@northwind/ui/components/sonner";
import type { QueryClient } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRouteWithContext,
  useLocation,
} from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import type { TRPCOptionsProxy } from "@trpc/tanstack-react-query";

import { ThemeProvider } from "@/components/theme-provider";
import { AnalyticsConsentBanner } from "@/components/analytics-consent";
import { AnalyticsLifecycle } from "@/components/analytics-lifecycle";
import { AppShell, useSessionUser } from "@/components/app-shell";
import { getRequestAnalyticsConsentPolicy } from "@/lib/analytics-policy.functions";
import { getRequestSessionUser } from "@/lib/session-user.functions";
import { absoluteUrl, createSeoHead } from "@/lib/seo";
import { isProductStandalonePath, productHome } from "@/product";

import appCss from "../index.css?url";

export interface RouterAppContext {
  nonce: string;
  queryClient: QueryClient;
  trpc: TRPCOptionsProxy<AppRouter>;
}

function securityHeaders(nonce?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Cache-Control": "private, no-store",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    Vary: "CF-IPCountry",
  };

  if (import.meta.env.PROD) {
    headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains; preload";
  }

  if (import.meta.env.PROD && nonce) {
    const apiOrigin = new URL(env.VITE_SERVER_URL).origin;
    // A production build pointed at a local HTTP API (end-to-end tests) also reads screenshots from the
    // local S3 stand-in; deployed builds always use HTTPS origins, which `https:` already covers.
    const localImages = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(apiOrigin) ? " http://localhost:* http://127.0.0.1:*" : "";
    const analyticsOrigin = env.VITE_POSTHOG_PROJECT_TOKEN
      ? new URL(env.VITE_POSTHOG_HOST).origin
      : null;
    headers["Content-Security-Policy"] = [
      "default-src 'self'",
      `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
      "style-src 'self' 'unsafe-inline'",
      `img-src 'self' data: blob: https:${localImages}`,
      "font-src 'self' data:",
      `connect-src 'self' ${apiOrigin}${analyticsOrigin ? ` ${analyticsOrigin}` : ""}`,
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; ");
  }

  return headers;
}

export const Route = createRootRouteWithContext<RouterAppContext>()({
  component: RootDocument,
  headers: ({ ssr }) => securityHeaders(ssr?.nonce),
  staleTime: Infinity,
  loader: async () => {
    const [analyticsConsentPolicy, initialUser] = await Promise.all([
      getRequestAnalyticsConsentPolicy().catch(() => "opt_in" as const),
      getRequestSessionUser().catch(() => null),
    ]);
    return { analyticsConsentPolicy, initialUser };
  },
  head: () => {
    const seo = createSeoHead({ path: productHome.to, canonical: false });
    return {
      meta: [
        { charSet: "utf-8" },
        { name: "viewport", content: "width=device-width, initial-scale=1" },
        { name: "application-name", content: env.VITE_BRAND_NAME },
        { name: "color-scheme", content: "light dark" },
        { name: "theme-color", content: "#f7f9fc", media: "(prefers-color-scheme: light)" },
        { name: "theme-color", content: "#202124", media: "(prefers-color-scheme: dark)" },
        ...seo.meta,
      ],
      links: [
        {
          rel: "stylesheet",
          href: appCss,
        },
        {
          rel: "icon",
          href: "/brand/northwind-icon.svg",
          type: "image/svg+xml",
        },
        {
          rel: "apple-touch-icon",
          href: "/brand/northwind-icon-180.png",
          sizes: "180x180",
        },
        {
          rel: "sitemap",
          href: absoluteUrl("/sitemap.xml"),
          type: "application/xml",
        },
      ],
    };
  },
});

function RootDocument() {
  const { nonce } = Route.useRouteContext();
  const { analyticsConsentPolicy } = Route.useLoaderData();

  return (
    <html
      lang="en"
      data-analytics-consent-policy={analyticsConsentPolicy}
      suppressHydrationWarning
    >
      <head>
        <HeadContent />
      </head>
      <body>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
          storageKey="vite-ui-theme"
          nonce={nonce}
        >
          <AnalyticsLifecycle />
          <ShellOutlet />
          <AnalyticsConsentBanner />
          <Toaster richColors />
        </ThemeProvider>
        {import.meta.env.DEV ? (
          <>
            <TanStackRouterDevtools position="bottom-left" />
            {/* Bottom-right belongs to the assistant launcher. */}
            <ReactQueryDevtools position="bottom" buttonPosition="top-left" />
          </>
        ) : null}
        <Scripts />
      </body>
    </html>
  );
}

function ShellOutlet() {
  const { initialUser } = Route.useLoaderData();
  const { user, sessionStatus } = useSessionUser(initialUser);
  const pathname = useLocation({ select: (location) => location.pathname });
  const standalone =
    pathname === "/login" ||
    pathname === "/privacy" ||
    pathname === "/terms" ||
    pathname.startsWith("/account/") ||
    pathname === "/admin" ||
    pathname.startsWith("/admin/") ||
    isProductStandalonePath(pathname);

  return standalone ? (
    <Outlet />
  ) : (
    <AppShell user={user} sessionStatus={sessionStatus}>
      <div className="min-w-0">
        <Outlet />
      </div>
    </AppShell>
  );
}
