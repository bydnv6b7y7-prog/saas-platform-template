export type AssistantRunPhase =
  | "understanding"
  | "updating-page"
  | "using-tool"
  | "preparing-answer"
  | "writing"
  | null;

type AssistantRunState = {
  runId: string | null;
  activeTools: Readonly<Record<string, string>>;
  hasCompletedTool: boolean;
  textMessageId: string | null;
  waitingForOutput: boolean;
};

export const INITIAL_ASSISTANT_RUN_STATE: AssistantRunState = {
  runId: null,
  activeTools: {},
  hasCompletedTool: false,
  textMessageId: null,
  waitingForOutput: false,
};

export type AssistantRunStateEvent =
  | { type: "run-initialized"; runId: string }
  | {
      type: "tool-started";
      runId: string;
      toolCallId: string;
      toolName: string;
    }
  | { type: "tool-completed"; runId: string; toolCallId: string }
  | { type: "text-started"; runId: string; messageId: string }
  | {
      type: "text-content";
      runId: string;
      messageId: string;
      delta: string;
    }
  | { type: "text-ended"; runId: string; messageId: string }
  | { type: "run-finished"; runId: string }
  | { type: "run-failed"; runId: string };

export const ASSISTANT_RUN_PHASE_LABELS: Record<
  Exclude<AssistantRunPhase, null>,
  string
> = {
  understanding: "Understanding request",
  "updating-page": "Updating page",
  "using-tool": "Working with App Store data",
  "preparing-answer": "Preparing answer",
  writing: "Writing answer",
};

export function reduceAssistantRunState(
  state: AssistantRunState,
  event: AssistantRunStateEvent,
): AssistantRunState {
  if (event.type === "run-initialized") {
    return {
      ...INITIAL_ASSISTANT_RUN_STATE,
      runId: event.runId,
      waitingForOutput: true,
    };
  }

  if (state.runId !== event.runId) return state;
  if (event.type === "run-finished" || event.type === "run-failed") {
    return INITIAL_ASSISTANT_RUN_STATE;
  }
  if (event.type === "tool-started") {
    return {
      ...state,
      activeTools: {
        ...state.activeTools,
        [event.toolCallId]: event.toolName,
      },
      waitingForOutput: true,
    };
  }
  if (event.type === "tool-completed") {
    if (!(event.toolCallId in state.activeTools)) return state;
    const { [event.toolCallId]: _completed, ...activeTools } =
      state.activeTools;
    return {
      ...state,
      activeTools,
      hasCompletedTool: true,
      waitingForOutput: true,
    };
  }
  if (event.type === "text-started") {
    return {
      ...state,
      textMessageId: event.messageId,
    };
  }
  if (event.type === "text-content") {
    if (state.textMessageId !== event.messageId || event.delta.length === 0) {
      return state;
    }
    return {
      ...state,
      textMessageId: event.messageId,
      waitingForOutput: false,
    };
  }
  if (state.textMessageId !== event.messageId) return state;
  return {
    ...state,
    textMessageId: null,
  };
}

export function assistantRunPhase(state: AssistantRunState): AssistantRunPhase {
  if (!state.runId) return null;

  if (Object.keys(state.activeTools).length > 0) {
    return "using-tool";
  }

  if (!state.waitingForOutput) return null;
  if (state.textMessageId) return "writing";
  if (!state.hasCompletedTool) return "understanding";
  return "preparing-answer";
}

export function visibleAssistantRunPhase(
  state: AssistantRunState,
  isRunning: boolean,
): AssistantRunPhase {
  return isRunning ? assistantRunPhase(state) : null;
}
