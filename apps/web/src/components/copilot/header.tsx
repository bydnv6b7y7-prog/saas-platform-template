import {
  CopilotModalHeader,
  useCopilotChatConfiguration,
} from "@copilotkit/react-core/v2";
import { Link } from "@tanstack/react-router";
import {
  History,
  Plus,
  X,
} from "lucide-react";
import { useEffect } from "react";

import { BrandMark } from "@/components/brand-mark";
import { assistantPageContextLabel } from "@/product";
import { assistantQuotaMessage } from "@/lib/assistant-usage";
import {
  SIDEBAR_ID,
  focusChatInput,
  useAssistantControl,
} from "./context";
import { AssistantHistoryDrawer } from "./history-drawer";

export const AppStoreCopilotHeader = Object.assign(
  function AppStoreCopilotHeader() {
    const {
      clearError,
      error,
      historyOpen,
      isRunning,
      onOpenChange,
      pageContext,
      setHistoryOpen,
      startNewThread,
      usage,
    } = useAssistantControl();
    const configuration = useCopilotChatConfiguration();
    const quotaExhausted = usage.daily.remaining === 0;
    const quotaLow = usage.daily.remaining === 1;
    const resetLabel = new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(usage.daily.resetAt));

    useEffect(() => {
      const sidebar = document.getElementById(SIDEBAR_ID);
      if (!sidebar) return;
      const chat = sidebar.querySelector<HTMLElement>("[data-sidebar-chat]");
      const previousInert = chat?.inert ?? false;
      if (chat) chat.inert = historyOpen ? true : previousInert;
      if (historyOpen) {
        requestAnimationFrame(() => {
          sidebar
            .querySelector<HTMLButtonElement>("[data-assistant-history-close]")
            ?.focus({ preventScroll: true });
        });
      }
      return () => {
        if (chat) chat.inert = previousInert;
      };
    }, [historyOpen]);

    const close = () => {
      configuration?.setModalOpen(false);
      onOpenChange(false);
    };
    const newConversation = () => {
      if (isRunning) return;
      startNewThread();
      focusChatInput();
    };

    return (
      <>
        <header
          inert={historyOpen}
          className="app-chrome border-b border-border/70 px-3 py-2.5"
        >
          <div className="flex min-h-11 items-center gap-2">
            <span
              className="grid size-9 shrink-0 place-items-center rounded-xl bg-brand/10 text-brand"
              aria-hidden="true"
            >
              <BrandMark className="size-6" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold tracking-[-0.01em] text-foreground">
                Northwind AI
                <span className="ml-2 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  {usage.accessSource === "admin" ? "admin" : usage.plan}
                </span>
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {assistantPageContextLabel(pageContext)}
              </p>
            </div>
            <button
              type="button"
              data-assistant-history-trigger
              aria-label="Open conversation history"
              title="History"
              onClick={() => setHistoryOpen(true)}
              className="assistant-icon-button"
            >
              <History className="size-4.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label="Start a new conversation"
              title="New conversation"
              disabled={isRunning}
              onClick={newConversation}
              className="assistant-icon-button disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Plus className="size-5" aria-hidden="true" />
            </button>
            <button
              type="button"
              data-assistant-close
              aria-label="Close Northwind AI"
              title="Close"
              onClick={close}
              className="assistant-icon-button"
            >
              <X className="size-5" aria-hidden="true" />
            </button>
          </div>
          {usage.plan === "free" && (quotaLow || quotaExhausted) ? (
            <div
              aria-live="polite"
              className={`mt-2 flex min-h-9 items-center justify-between gap-3 rounded-xl px-3 py-1.5 text-xs ${
                quotaExhausted
                  ? "bg-amber-500/12 text-amber-900 dark:text-amber-100"
                  : "bg-brand/10 text-brand"
              }`}
            >
              <span>
                {quotaExhausted
                  ? `Daily limit reached · Resets at ${resetLabel}`
                  : assistantQuotaMessage(usage)}
              </span>
              {quotaExhausted ? (
                <Link
                  to="/pricing"
                  className="shrink-0 font-medium underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                >
                  Upgrade
                </Link>
              ) : null}
            </div>
          ) : null}
          {error ? (
            <div
              role="alert"
              className="mt-2 flex items-center justify-between gap-3 rounded-xl bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              <span>{error}</span>
              <button
                type="button"
                onClick={clearError}
                className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg px-2.5 font-medium outline-none hover:bg-destructive/10 focus-visible:ring-2 focus-visible:ring-destructive/30"
              >
                Dismiss
              </button>
            </div>
          ) : null}
        </header>
        {historyOpen ? <AssistantHistoryDrawer /> : null}
      </>
    );
  },
  {
    displayName: "AppStoreCopilotHeader",
    Title: CopilotModalHeader.Title,
    CloseButton: CopilotModalHeader.CloseButton,
    DrawerLauncher: CopilotModalHeader.DrawerLauncher,
  },
);
