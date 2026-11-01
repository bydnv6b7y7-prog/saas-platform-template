import type { AssistantUsageStatus } from "@northwind/billing";
import {
  CopilotChat,
  useCopilotChatConfiguration,
} from "@copilotkit/react-core/v2";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

import { assistantUsageQueryKey } from "@/lib/assistant-usage";

import { AssistantBehavior } from "./behavior";
import {
  AGENT_ID,
  AssistantControlContext,
  type AssistantControlValue,
} from "./context";
import { AssistantInput } from "./input";
import { useAssistantLifecycle } from "./lifecycle";
import { AssistantMessageView } from "./message-view";
import { SidebarResizeHandle } from "./resize-handle";
import { AssistantScrollView } from "./scroll-view";
import { AssistantSidebarView } from "./sidebar-view";
import {
  AssistantPageTools,
  AssistantToolRenderers,
  assistantInputPlaceholder,
  assistantVerifyHint,
  useAssistantPageContext,
} from "@/product/assistant";
import { AssistantWelcomeScreen } from "./welcome-screen";

function useRequiredChatConfiguration() {
  const configuration = useCopilotChatConfiguration();
  if (!configuration) {
    throw new Error("The assistant must be rendered inside CopilotKit.");
  }
  return configuration;
}

export function AssistantRuntime({
  clearError,
  error,
  onOpenChange,
  open,
  usage,
  userId,
}: {
  clearError: () => void;
  error: string | null;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  usage: AssistantUsageStatus;
  userId: string;
}) {
  const pageContext = useAssistantPageContext();
  const queryClient = useQueryClient();
  const configuration = useRequiredChatConfiguration();
  const { isRunning, phase, stop } = useAssistantLifecycle(clearError, userId);
  const [historyOpen, setHistoryOpen] = useState(false);

  // Resolve thread mutations above the sidebar view. Its nested provider becomes
  // prop-controlled after selecting history and intentionally rejects them.
  const selectThread = useCallback(
    (threadId: string) =>
      configuration.setActiveThreadId(threadId, { explicit: true }),
    [configuration.setActiveThreadId],
  );

  useEffect(() => {
    if (!open) setHistoryOpen(false);
  }, [open]);

  useEffect(() => {
    const delay = Math.max(
      0,
      new Date(usage.daily.resetAt).getTime() - Date.now() + 100,
    );
    const timer = window.setTimeout(() => {
      void queryClient.invalidateQueries({
        queryKey: assistantUsageQueryKey(userId),
      });
    }, delay);
    return () => window.clearTimeout(timer);
  }, [queryClient, usage.daily.resetAt, userId]);

  const controls = useMemo<AssistantControlValue>(
    () => ({
      open,
      error: error ?? (usage.configured ? null : "The assistant is not set up yet: the server has no model key (run bun run doctor)."),
      activeThreadId: configuration.threadId,
      pageContext,
      phase,
      isRunning,
      historyOpen,
      usage,
      userId,
      clearError,
      onOpenChange,
      selectThread,
      setHistoryOpen,
      startNewThread: configuration.startNewThread,
    }),
    [
      configuration.startNewThread,
      configuration.threadId,
      error,
      clearError,
      historyOpen,
      isRunning,
      onOpenChange,
      open,
      pageContext,
      phase,
      selectThread,
      usage,
      userId,
    ],
  );

  return (
    <AssistantControlContext.Provider value={controls}>
      <div
        data-assistant
        data-open={open ? "true" : "false"}
        style={{ display: "contents" }}
      >
        <AssistantBehavior pageContext={pageContext} />
        <AssistantPageTools />
        <AssistantToolRenderers />
        <SidebarResizeHandle />
        <CopilotChat
          agentId={AGENT_ID}
          chatView={AssistantSidebarView}
          isModalDefaultOpen={false}
          onStop={stop}
          input={AssistantInput}
          messageView={AssistantMessageView}
          scrollView={AssistantScrollView}
          welcomeScreen={AssistantWelcomeScreen}
          labels={{
            chatInputPlaceholder: assistantInputPlaceholder,
            chatDisclaimerText:
              usage.plan === "free"
                ? `AI-generated · ${usage.limits.perDay} free requests reset daily · ${assistantVerifyHint}`
                : `AI-generated · Chats and preferences are saved to your account · ${assistantVerifyHint}`,
          }}
        />
      </div>
    </AssistantControlContext.Provider>
  );
}
