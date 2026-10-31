import { describe, expect, it } from "bun:test";

import {
  assistantThreadsQueryKey,
  removeAssistantThreadFromCache,
} from "./assistant-threads";
import {
  INITIAL_ASSISTANT_RUN_STATE,
  type AssistantRunStateEvent,
  assistantRunPhase,
  reduceAssistantRunState,
  visibleAssistantRunPhase,
} from "./assistant-run-state";
import {
  COPILOT_SIDEBAR_DEFAULT_WIDTH,
  COPILOT_SIDEBAR_MAX_WIDTH,
  COPILOT_SIDEBAR_MIN_WIDTH,
  clampCopilotSidebarWidth,
  copilotSidebarWidthForKey,
} from "./assistant-sidebar-width";
import { resolveAssistantSurfaceState } from "./assistant-surface-state";
import {
  hasAssistantText,
  normalizeAssistantThreadTitle,
} from "./assistant-thread-title";

describe("App Store Copilot run phases", () => {
  it("tracks concurrent tools and stops showing a loader once text is visible", () => {
    const events = [
      { type: "run-initialized", runId: "run-a" },
      {
        type: "tool-started",
        runId: "run-a",
        toolCallId: "chart",
        toolName: "getLatestChart",
      },
      {
        type: "tool-started",
        runId: "run-a",
        toolCallId: "brief",
        toolName: "createRankingsBrief",
      },
    ] as const;
    const reading = events
      .slice(0, 2)
      .reduce(reduceAssistantRunState, INITIAL_ASSISTANT_RUN_STATE);
    const building = events.reduce(
      reduceAssistantRunState,
      INITIAL_ASSISTANT_RUN_STATE,
    );

    expect(assistantRunPhase(reading)).toBe("using-tool");
    expect(assistantRunPhase(building)).toBe("using-tool");

    const chartStillRunning = reduceAssistantRunState(building, {
      type: "tool-completed",
      runId: "run-a",
      toolCallId: "brief",
    });
    expect(assistantRunPhase(chartStillRunning)).toBe("using-tool");

    const preparing = reduceAssistantRunState(chartStillRunning, {
      type: "tool-completed",
      runId: "run-a",
      toolCallId: "chart",
    });
    expect(assistantRunPhase(preparing)).toBe("preparing-answer");

    const writing = reduceAssistantRunState(preparing, {
      type: "text-started",
      runId: "run-a",
      messageId: "answer",
    });
    expect(assistantRunPhase(writing)).toBe("writing");

    const visible = reduceAssistantRunState(writing, {
      type: "text-content",
      runId: "run-a",
      messageId: "answer",
      delta: "Visible answer",
    });
    expect(assistantRunPhase(visible)).toBeNull();
    expect(
      assistantRunPhase(
        reduceAssistantRunState(visible, {
          type: "text-ended",
          runId: "run-a",
          messageId: "answer",
        }),
      ),
    ).toBeNull();
  });

  it("shows real work again when a visible preamble is followed by a tool", () => {
    const visiblePreamble = (
      [
        { type: "run-initialized", runId: "run-a" },
        {
          type: "text-started",
          runId: "run-a",
          messageId: "preamble",
        },
        {
          type: "text-content",
          runId: "run-a",
          messageId: "preamble",
          delta: "I’ll check.",
        },
        {
          type: "text-ended",
          runId: "run-a",
          messageId: "preamble",
        },
      ] satisfies AssistantRunStateEvent[]
    ).reduce(reduceAssistantRunState, INITIAL_ASSISTANT_RUN_STATE);
    expect(assistantRunPhase(visiblePreamble)).toBeNull();

    const reading = reduceAssistantRunState(visiblePreamble, {
      type: "tool-started",
      runId: "run-a",
      toolCallId: "chart",
      toolName: "getLatestChart",
    });
    expect(assistantRunPhase(reading)).toBe("using-tool");

    const readingRange = reduceAssistantRunState(visiblePreamble, {
      type: "tool-started",
      runId: "run-a",
      toolCallId: "range",
      toolName: "getDateRangeLeaderboard",
    });
    expect(assistantRunPhase(readingRange)).toBe("using-tool");
  });

  it("keeps streamed tool events generic until client execution is known", () => {
    const updating = (
      [
        { type: "run-initialized", runId: "run-a" },
        {
          type: "tool-started",
          runId: "run-a",
          toolCallId: "view",
          toolName: "setRankingView",
        },
      ] satisfies AssistantRunStateEvent[]
    ).reduce(reduceAssistantRunState, INITIAL_ASSISTANT_RUN_STATE);

    expect(assistantRunPhase(updating)).toBe("using-tool");
  });

  it("uses the same honest phase for App ranking history", () => {
    const reading = (
      [
        { type: "run-initialized", runId: "run-a" },
        {
          type: "tool-started",
          runId: "run-a",
          toolCallId: "history",
          toolName: "getAppRankingHistory",
        },
      ] satisfies AssistantRunStateEvent[]
    ).reduce(reduceAssistantRunState, INITIAL_ASSISTANT_RUN_STATE);

    expect(assistantRunPhase(reading)).toBe("using-tool");
  });

  it("ignores late events from a superseded run and always clears terminal runs", () => {
    const runA = reduceAssistantRunState(INITIAL_ASSISTANT_RUN_STATE, {
      type: "run-initialized",
      runId: "run-a",
    });
    const runB = reduceAssistantRunState(runA, {
      type: "run-initialized",
      runId: "run-b",
    });
    const staleFinish = reduceAssistantRunState(runB, {
      type: "run-finished",
      runId: "run-a",
    });

    expect(staleFinish.runId).toBe("run-b");
    expect(assistantRunPhase(staleFinish)).toBe("understanding");
    expect(
      reduceAssistantRunState(staleFinish, {
        type: "run-failed",
        runId: "run-b",
      }),
    ).toEqual(INITIAL_ASSISTANT_RUN_STATE);
  });

  it("never shows a stale phase after the agent stops", () => {
    const initialized = reduceAssistantRunState(INITIAL_ASSISTANT_RUN_STATE, {
      type: "run-initialized",
      runId: "run-a",
    });

    expect(visibleAssistantRunPhase(initialized, true)).toBe("understanding");
    expect(visibleAssistantRunPhase(initialized, false)).toBeNull();
  });

  it("ignores unmatched tool results and text chunks", () => {
    const reading = (
      [
        { type: "run-initialized", runId: "run-a" },
        {
          type: "tool-started",
          runId: "run-a",
          toolCallId: "chart",
          toolName: "getLatestChart",
        },
      ] satisfies AssistantRunStateEvent[]
    ).reduce(reduceAssistantRunState, INITIAL_ASSISTANT_RUN_STATE);
    const unknownResult = reduceAssistantRunState(reading, {
      type: "tool-completed",
      runId: "run-a",
      toolCallId: "unknown",
    });
    expect(unknownResult).toBe(reading);

    const writing = reduceAssistantRunState(reading, {
      type: "text-started",
      runId: "run-a",
      messageId: "answer",
    });
    const unrelatedText = reduceAssistantRunState(writing, {
      type: "text-content",
      runId: "run-a",
      messageId: "another-message",
      delta: "Not this answer",
    });
    expect(unrelatedText).toBe(writing);
    expect(assistantRunPhase(unrelatedText)).toBe("using-tool");
  });
});

describe("App Store Copilot conversation titles", () => {
  it("uses the first non-empty user message, normalizes whitespace, and truncates Unicode", () => {
    const longTitle = `  Review\n\t${"🧭".repeat(80)}  `;
    const title = normalizeAssistantThreadTitle([
      { role: "assistant", content: "Ignored" },
      { role: "user", content: "   " },
      { role: "user", content: longTitle },
    ]);

    expect(title?.startsWith("Review 🧭")).toBe(true);
    expect(Array.from(title ?? "")).toHaveLength(64);
    expect(title?.endsWith("…")).toBe(true);
  });

  it("requires visible assistant text before treating an answer as complete", () => {
    expect(
      hasAssistantText([
        { role: "assistant", content: "  " },
        { role: "assistant", content: [{ type: "tool-call" }] },
      ]),
    ).toBe(false);
    expect(
      hasAssistantText([
        {
          role: "assistant",
          content: [{ type: "text", text: " Answer " }],
        },
      ]),
    ).toBe(true);
  });

  it("isolates cached conversation pages by authenticated user", () => {
    expect(assistantThreadsQueryKey("user-1")).not.toEqual(
      assistantThreadsQueryKey("user-2"),
    );
  });

  it("removes a deleted conversation from every cached page immediately", () => {
    const cached = {
      pageParams: [0],
      pages: [
        {
          threads: [
            {
              id: "thread-1",
              title: "First",
              createdAt: "2026-09-01T00:00:00.000Z",
              updatedAt: "2026-09-01T00:00:00.000Z",
            },
          ],
          total: 1,
          page: 0,
          perPage: 20,
          hasMore: false,
        },
      ],
    };

    expect(removeAssistantThreadFromCache(cached, "thread-1")).toEqual({
      pageParams: [0],
      pages: [
        {
          threads: [],
          total: 0,
          page: 0,
          perPage: 20,
          hasMore: false,
        },
      ],
    });
  });
});

describe("App Store Copilot sidebar width", () => {
  it("clamps stored and dragged widths", () => {
    expect(clampCopilotSidebarWidth(Number.NaN)).toBe(
      COPILOT_SIDEBAR_DEFAULT_WIDTH,
    );
    expect(clampCopilotSidebarWidth(200)).toBe(COPILOT_SIDEBAR_MIN_WIDTH);
    expect(clampCopilotSidebarWidth(900)).toBe(COPILOT_SIDEBAR_MAX_WIDTH);
  });

  it("uses spatially correct keyboard directions", () => {
    expect(copilotSidebarWidthForKey(420, "ArrowLeft")).toBe(436);
    expect(copilotSidebarWidthForKey(420, "ArrowRight")).toBe(404);
    expect(copilotSidebarWidthForKey(420, "Home")).toBe(360);
    expect(copilotSidebarWidthForKey(420, "End")).toBe(520);
    expect(copilotSidebarWidthForKey(420, "Enter")).toBeNull();
  });
});

describe("App Store Copilot surface accessibility", () => {
  it("removes a closed sidebar from keyboard and accessibility interaction", () => {
    expect(
      resolveAssistantSurfaceState({
        appShellWasInert: false,
        compact: false,
        open: false,
      }),
    ).toEqual({
      compactModalOpen: false,
      appShellInert: false,
      sidebarInert: true,
    });
  });

  it("isolates the app only while the compact assistant is open", () => {
    expect(
      resolveAssistantSurfaceState({
        appShellWasInert: false,
        compact: true,
        open: true,
      }),
    ).toEqual({
      compactModalOpen: true,
      appShellInert: true,
      sidebarInert: false,
    });
    expect(
      resolveAssistantSurfaceState({
        appShellWasInert: true,
        compact: false,
        open: true,
      }).appShellInert,
    ).toBe(true);
  });
});
