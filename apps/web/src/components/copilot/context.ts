import { ASSISTANT_AGENT_ID, type AssistantPageContext } from "@northwind/product/assistant-contracts";
import type { AssistantUsageStatus } from "@northwind/billing";
import { env } from "@northwind/env/web";
import type { CopilotKitProps } from "@copilotkit/react-core/v2";
import { createContext, useContext } from "react";

import type { AssistantRunPhase } from "@/lib/assistant-run-state";

export const AGENT_ID = ASSISTANT_AGENT_ID;
export const SIDEBAR_ID = "assistant-sidebar";
export const COMPACT_ASSISTANT_QUERY = "(max-width: 1099px)";
export const COPILOT_RUNTIME_URL = `${env.VITE_SERVER_URL.replace(/\/$/, "")}/api/copilotkit`;
const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "a[href]",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export type CopilotErrorEvent = Parameters<
  NonNullable<CopilotKitProps["onError"]>
>[0];

export type AssistantControlValue = {
  open: boolean;
  error: string | null;
  activeThreadId: string;
  pageContext: AssistantPageContext;
  phase: AssistantRunPhase;
  isRunning: boolean;
  historyOpen: boolean;
  usage: AssistantUsageStatus;
  userId: string;
  clearError: () => void;
  onOpenChange: (open: boolean) => void;
  selectThread: (threadId: string) => void;
  setHistoryOpen: (open: boolean) => void;
  startNewThread: () => void;
};

export const AssistantControlContext =
  createContext<AssistantControlValue | null>(null);

export function useAssistantControl(): AssistantControlValue {
  const value = useContext(AssistantControlContext);
  if (!value) {
    throw new Error("Assistant controls must be used inside AssistantCopilot.");
  }
  return value;
}

export function visibleFocusableElements(
  container: HTMLElement,
): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter(
    (element) =>
      element.getClientRects().length > 0 &&
      element.getAttribute("aria-hidden") !== "true" &&
      !element.closest("[inert]"),
  );
}

export function focusHistoryTrigger() {
  requestAnimationFrame(() => {
    document
      .querySelector<HTMLButtonElement>("[data-assistant-history-trigger]")
      ?.focus({ preventScroll: true });
  });
}

export function focusChatInput() {
  requestAnimationFrame(() => {
    document
      .getElementById(SIDEBAR_ID)
      ?.querySelector<HTMLTextAreaElement>("textarea:not([disabled])")
      ?.focus({ preventScroll: true });
  });
}
