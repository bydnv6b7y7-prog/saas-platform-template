import {
  useCopilotChatConfiguration,
  type CopilotChatToggleButtonProps,
} from "@copilotkit/react-core/v2";
import {
  forwardRef,
  useEffect,
  useLayoutEffect,
} from "react";

import { resolveAssistantSurfaceState } from "@/lib/assistant-surface-state";

import {
  COMPACT_ASSISTANT_QUERY,
  SIDEBAR_ID,
  focusHistoryTrigger,
  useAssistantControl,
  visibleFocusableElements,
} from "./context";

export const CopilotSurfaceBridge = forwardRef<
  HTMLButtonElement,
  CopilotChatToggleButtonProps
>(function CopilotSurfaceBridge() {
  const { historyOpen, onOpenChange, open, setHistoryOpen } =
    useAssistantControl();
  const configuration = useCopilotChatConfiguration();
  const isModalOpen = configuration?.isModalOpen;
  const setModalOpen = configuration?.setModalOpen;

  useLayoutEffect(() => {
    if (!setModalOpen || isModalOpen === open) return;
    setModalOpen(open);
  }, [isModalOpen, open, setModalOpen]);

  useLayoutEffect(() => {
    if (typeof window === "undefined") return;

    const media = window.matchMedia(COMPACT_ASSISTANT_QUERY);
    const appShell = document.querySelector<HTMLElement>("[data-app-shell]");
    const sidebar = document.querySelector<HTMLElement>(
      "[data-testid='copilot-sidebar']",
    );
    const previousAppShellInert = appShell?.inert ?? false;
    const previousSidebarInert = sidebar?.inert ?? false;
    const previousRole = sidebar?.getAttribute("role");
    const previousAriaLabel = sidebar?.getAttribute("aria-label");

    if (sidebar) {
      sidebar.id = SIDEBAR_ID;
      sidebar.setAttribute("aria-label", "Northwind AI assistant");
    }

    const updateMode = () => {
      const state = resolveAssistantSurfaceState({
        appShellWasInert: previousAppShellInert,
        compact: media.matches,
        open,
      });
      document.body.classList.toggle(
        "northwind-copilot-modal-open",
        state.compactModalOpen,
      );
      if (appShell) appShell.inert = state.appShellInert;
      if (!sidebar) return;
      sidebar.inert = state.sidebarInert;

      if (state.compactModalOpen) {
        sidebar.setAttribute("role", "dialog");
        sidebar.setAttribute("aria-modal", "true");
      } else {
        sidebar.setAttribute("role", previousRole ?? "complementary");
        sidebar.removeAttribute("aria-modal");
      }
    };

    updateMode();
    media.addEventListener("change", updateMode);
    return () => {
      media.removeEventListener("change", updateMode);
      document.body.classList.remove("northwind-copilot-modal-open");
      if (appShell) appShell.inert = previousAppShellInert;
      if (sidebar) {
        sidebar.inert = previousSidebarInert;
        sidebar.setAttribute("role", previousRole ?? "complementary");
        sidebar.removeAttribute("aria-modal");
        if (previousAriaLabel) {
          sidebar.setAttribute("aria-label", previousAriaLabel);
        } else {
          sidebar.removeAttribute("aria-label");
        }
      }
    };
  }, [open]);

  useEffect(() => {
    if (!open || typeof window === "undefined") return;

    const focusAssistant = () => {
      const sidebar = document.getElementById(SIDEBAR_ID);
      if (!sidebar) return;
      const preferred =
        sidebar.querySelector<HTMLElement>("textarea:not([disabled])") ??
        sidebar.querySelector<HTMLElement>("[data-assistant-close]");
      preferred?.focus({ preventScroll: true });
    };
    const focusFrame = requestAnimationFrame(focusAssistant);

    const handleKeyDown = (event: KeyboardEvent) => {
      const sidebar = document.getElementById(SIDEBAR_ID);
      if (!sidebar) return;

      if (event.key === "Escape") {
        event.preventDefault();
        if (historyOpen) {
          setHistoryOpen(false);
          focusHistoryTrigger();
          return;
        }
        setModalOpen?.(false);
        onOpenChange(false);
        return;
      }

      if (
        event.key !== "Tab" ||
        !window.matchMedia(COMPACT_ASSISTANT_QUERY).matches
      ) {
        return;
      }

      const focusable = visibleFocusableElements(sidebar);
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      const active = document.activeElement;

      if (event.shiftKey && (active === first || !sidebar.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (active === last || !sidebar.contains(active))
      ) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [historyOpen, onOpenChange, open, setHistoryOpen, setModalOpen]);

  return null;
});
