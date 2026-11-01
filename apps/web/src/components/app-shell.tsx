import {
  Suspense,
  createContext,
  lazy,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import {
  AssistantOrb,
  type AssistantAccess,
} from "@/components/assistant-orb";
import Header from "@/components/header";
import { productFooterLinks } from "@/product";
import {
  useTheme,
  useThemeTransition,
  type ThemeChoice,
} from "@/components/theme-provider";
import { authClient } from "@/lib/auth-client";
import { adminAccessQueryOptions } from "@/lib/admin-access";
import { assistantUsageQueryOptions } from "@/lib/assistant-usage";
import { captureAnalytics, sanitizeAnalyticsUrl } from "@/lib/analytics";
import type { AssistantOpenSource } from "@northwind/analytics";

import type { AppUser } from "@/lib/session-user";
export type { AppUser } from "@/lib/session-user";

export type SessionStatus = {
  isPending: boolean;
  error: unknown;
  retry: () => void;
};

type AssistantSurfaceValue = {
  access: AssistantAccess;
  open: boolean;
  openAssistant: () => void;
};

const AssistantSurfaceContext = createContext<AssistantSurfaceValue | null>(
  null,
);
const AssistantCopilot = lazy(() =>
  import("@/components/copilot").then((module) => ({
    default: module.AssistantCopilot,
  })),
);

function SiteFooter() {
  const { theme } = useTheme();
  const switchTheme = useThemeTransition();

  return (
    <footer className="border-t border-border/70 pb-[calc(5rem+env(safe-area-inset-bottom))] md:pb-0">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-6 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <nav aria-label="Product information" className="flex flex-wrap gap-x-5 gap-y-1">
          <Link to="/pricing" className="inline-flex min-h-11 items-center hover:text-foreground">
            Pricing
          </Link>
          {productFooterLinks.map(({ to, label }) => (
            <Link key={to} to={to} className="inline-flex min-h-11 items-center hover:text-foreground">
              {label}
            </Link>
          ))}
          <Link to="/privacy" className="inline-flex min-h-11 items-center hover:text-foreground">
            Privacy
          </Link>
          <Link
            to="/privacy"
            hash="analytics-controls"
            className="inline-flex min-h-11 items-center hover:text-foreground"
          >
            Privacy choices
          </Link>
          <Link to="/terms" className="inline-flex min-h-11 items-center hover:text-foreground">
            Terms
          </Link>
        </nav>
        <label className="flex min-h-11 items-center gap-2 text-xs">
          Appearance
          <select
            aria-label="Appearance"
            value={theme ?? "system"}
            onChange={(event) => switchTheme(event.target.value as ThemeChoice)}
            className="h-11 rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
          >
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
      </div>
    </footer>
  );
}

export function useOptionalAssistantSurface(): AssistantSurfaceValue | null {
  return useContext(AssistantSurfaceContext);
}

export function AppShell({
  children,
  user,
  sessionStatus,
}: {
  children: React.ReactNode;
  user: AppUser | null;
  sessionStatus?: SessionStatus;
}) {
  const [assistantOpen, setAssistantOpen] = useState(false);
  const assistantReturnFocusRef = useRef<HTMLElement | null>(null);
  const assistantUsage = useQuery({
    ...assistantUsageQueryOptions(user?.id ?? "anonymous"),
    enabled: Boolean(user),
  });
  const adminAccess = useQuery({
    ...adminAccessQueryOptions(user?.id ?? "anonymous"),
    enabled: Boolean(user),
  });
  const assistantAccess: AssistantAccess = assistantUsage.data
    ? "available"
    : assistantUsage.isPending && user
      ? "loading"
      : "unavailable";

  useEffect(() => {
    if (assistantAccess !== "available") setAssistantOpen(false);
  }, [assistantAccess]);

  const handleAssistantOpenChange = useCallback((open: boolean, source?: AssistantOpenSource) => {
    if (open && assistantAccess !== "available") return;

    if (open && !assistantOpen && source && typeof window !== "undefined") {
      captureAnalytics("assistant_opened", {
        path: sanitizeAnalyticsUrl(window.location.pathname),
        source,
      });
    }

    if (open && typeof document !== "undefined") {
      const activeElement = document.activeElement;
      assistantReturnFocusRef.current =
        activeElement instanceof HTMLElement &&
        activeElement.matches("[data-assistant-trigger='true']")
          ? activeElement
          : null;
    }

    setAssistantOpen(open);
    if (open || typeof document === "undefined") return;

    requestAnimationFrame(() => {
      const returnTarget = assistantReturnFocusRef.current;
      assistantReturnFocusRef.current = null;
      if (returnTarget?.isConnected && returnTarget.getClientRects().length > 0) {
        returnTarget.focus({ preventScroll: true });
        return;
      }

      const trigger = Array.from(
        document.querySelectorAll<HTMLElement>("[data-assistant-trigger='true']"),
      ).find((element) => element.getClientRects().length > 0);
      trigger?.focus({ preventScroll: true });
    });
  }, [assistantAccess, assistantOpen]);

  const handleAssistantToggle = useCallback(() => {
    handleAssistantOpenChange(!assistantOpen, "floating_orb");
  }, [assistantOpen, handleAssistantOpenChange]);
  const openAssistant = useCallback(() => {
    handleAssistantOpenChange(true, "page_cta");
  }, [handleAssistantOpenChange]);
  const assistantSurface = useMemo<AssistantSurfaceValue>(
    () => ({ access: assistantAccess, open: assistantOpen, openAssistant }),
    [assistantAccess, assistantOpen, openAssistant],
  );

  return (
    <AssistantSurfaceContext.Provider value={assistantSurface}>
      <div data-app-shell className="flex min-h-svh min-w-0 flex-col">
        <a href="#main-content" className="skip-link">
          Skip to content
        </a>
        <Header user={user} isAdmin={adminAccess.data === true} sessionStatus={sessionStatus} />
        <main id="main-content" className="min-w-0 flex-1">
          {children}
        </main>
        <SiteFooter />
        {user ? (
          <AssistantOrb
            access={assistantAccess}
            open={assistantOpen}
            onToggle={handleAssistantToggle}
          />
        ) : null}
      </div>
      {user && assistantUsage.data ? (
        <Suspense fallback={null}>
          <AssistantCopilot
            key={user.id}
            open={assistantOpen}
            onOpenChange={handleAssistantOpenChange}
            usage={assistantUsage.data}
            userId={user.id}
          />
        </Suspense>
      ) : null}
    </AssistantSurfaceContext.Provider>
  );
}

/** Keep this hook in the root so route changes cannot revive the SSR snapshot. */
export function useSessionUser(initialUser: AppUser | null) {
  const session = authClient.useSession();
  const [serverUser, setServerUser] = useState(initialUser);
  // Once the browser has checked its own Cookie, never restore an old SSR user
  // during a later logout, account switch, or session refetch.
  useEffect(() => {
    if (!session.isPending) setServerUser(null);
  }, [session.isPending]);
  const sessionUser = session.data?.user;
  const user = sessionUser
    ? {
        id: sessionUser.id,
        name: sessionUser.name ?? "Account",
        email: sessionUser.email,
      }
    : session.isPending ? serverUser : null;

  return {
    user,
    sessionStatus: {
      isPending: session.isPending,
      error: session.error,
      retry: () => { void session.refetch(); },
    },
  };
}
