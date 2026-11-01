import {
  UseAgentUpdate,
  useAgent,
  useCopilotKit,
} from "@copilotkit/react-core/v2";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
} from "react";

import {
  assistantThreadsQueryKey,
  updateAssistantThreadTitle,
} from "@/lib/assistant-threads";
import { assistantUsageQueryKey } from "@/lib/assistant-usage";
import {
  INITIAL_ASSISTANT_RUN_STATE,
  reduceAssistantRunState,
  visibleAssistantRunPhase,
} from "@/lib/assistant-run-state";
import {
  hasAssistantText,
  normalizeAssistantThreadTitle,
} from "@/lib/assistant-thread-title";

import { AGENT_ID } from "./context";

export function useAssistantLifecycle(
  onRunStarted: () => void,
  userId: string,
) {
  const queryClient = useQueryClient();
  const { copilotkit, executingToolCallIds } = useCopilotKit();
  const { agent, isReady } = useAgent({
    agentId: AGENT_ID,
    updates: [
      UseAgentUpdate.OnMessagesChanged,
      UseAgentUpdate.OnRunStatusChanged,
    ],
    throttleMs: 80,
  });
  const [runState, dispatch] = useReducer(
    reduceAssistantRunState,
    INITIAL_ASSISTANT_RUN_STATE,
  );
  const firstAnswerRun = useRef<{
    runId: string;
    threadId: string;
    hadAssistantText: boolean;
  } | null>(null);
  const activeRunId = useRef<string | null>(null);

  useEffect(() => {
    if (!isReady) return;
    const refreshUsage = () =>
      queryClient.invalidateQueries({ queryKey: assistantUsageQueryKey(userId) });
    const failRun = (runId: string) => {
      if (activeRunId.current !== runId) return;
      activeRunId.current = null;
      if (firstAnswerRun.current?.runId === runId) {
        firstAnswerRun.current = null;
      }
      dispatch({ type: "run-failed", runId });
      void refreshUsage();
    };
    const subscription = agent.subscribe({
      onRunStartedEvent: ({ event, input, messages }) => {
        // Connect replays historical events through the same subscriber. Only
        // a RUN_STARTED emitted for this wire request represents new work.
        if (event.runId !== input.runId) return;
        activeRunId.current = input.runId;
        onRunStarted();
        firstAnswerRun.current = {
          runId: input.runId,
          threadId: input.threadId,
          hadAssistantText: hasAssistantText(messages),
        };
        dispatch({ type: "run-initialized", runId: input.runId });
        void refreshUsage();
      },
      onToolCallStartEvent: ({ event, input }) => {
        if (activeRunId.current !== input.runId) return;
        dispatch({
          type: "tool-started",
          runId: input.runId,
          toolCallId: event.toolCallId,
          toolName: event.toolCallName,
        });
      },
      onToolCallResultEvent: ({ event, input }) => {
        if (activeRunId.current !== input.runId) return;
        dispatch({
          type: "tool-completed",
          runId: input.runId,
          toolCallId: event.toolCallId,
        });
      },
      onTextMessageStartEvent: ({ event, input }) => {
        if (
          activeRunId.current !== input.runId ||
          event.role !== "assistant"
        ) {
          return;
        }
        dispatch({
          type: "text-started",
          runId: input.runId,
          messageId: event.messageId,
        });
      },
      onTextMessageContentEvent: ({ event, input }) => {
        if (activeRunId.current !== input.runId) return;
        dispatch({
          type: "text-content",
          runId: input.runId,
          messageId: event.messageId,
          delta: event.delta,
        });
      },
      onTextMessageEndEvent: ({ event, input }) => {
        if (activeRunId.current !== input.runId) return;
        dispatch({
          type: "text-ended",
          runId: input.runId,
          messageId: event.messageId,
        });
      },
      onRunFinishedEvent: ({ event, input, messages, outcome }) => {
        if (
          event.runId !== input.runId ||
          activeRunId.current !== input.runId
        ) {
          return;
        }
        activeRunId.current = null;
        dispatch({ type: "run-finished", runId: input.runId });
        void refreshUsage();
        const run = firstAnswerRun.current;
        if (run?.runId === input.runId) firstAnswerRun.current = null;
        if (
          !run ||
          run.runId !== input.runId ||
          outcome !== "success" ||
          run.hadAssistantText ||
          !hasAssistantText(messages)
        ) {
          return;
        }
        const title = normalizeAssistantThreadTitle(messages);
        if (!title) return;
        void updateAssistantThreadTitle(run.threadId, title)
          .then(() =>
            queryClient.invalidateQueries({
              queryKey: assistantThreadsQueryKey(userId),
            }),
          )
          .catch(() => {
            console.warn("[assistant] Conversation title was not saved");
          });
      },
      onRunFailed: ({ input }) => failRun(input.runId),
      onRunErrorEvent: ({ input }) => failRun(input.runId),
    });
    return () => subscription.unsubscribe();
  }, [agent, isReady, onRunStarted, queryClient, userId]);

  const stop = useCallback(() => {
    const runId = activeRunId.current ?? runState.runId;
    // Clear the visible phase now, but retain the active id until the server's
    // terminal event refreshes the refunded quota.
    if (firstAnswerRun.current?.runId === runId) {
      firstAnswerRun.current = null;
    }
    if (runId) {
      dispatch({ type: "run-failed", runId });
    }
    try {
      copilotkit.stopAgent({ agent });
    } catch {
      console.error("[assistant] Stop failed");
      try {
        agent.abortRun();
      } catch {
        console.error("[assistant] Abort fallback failed");
      }
    }
  }, [agent, copilotkit, runState.runId]);

  const isUpdatingPage = executingToolCallIds.size > 0;
  const isRunning = agent.isRunning || isUpdatingPage;

  return {
    isRunning,
    phase: isUpdatingPage
      ? "updating-page"
      : visibleAssistantRunPhase(runState, agent.isRunning),
    stop,
  };
}
