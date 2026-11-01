import { describe, expect, it, spyOn } from "bun:test";
import {
  EventType,
  compactEvents,
  type BaseEvent,
  type RunAgentInput,
  type RunStartedEvent,
} from "@ag-ui/client";
import type { AgentRunnerRunRequest } from "@copilotkit/runtime/v2";
import { lastValueFrom, toArray } from "rxjs";

import {
  type AgentRunStatus,
  type AgentRunStore,
  type StartedAgentRun,
  type StoredAgentEvent,
} from "./postgres-agent-run-store";
import {
  isClientVisibleAgentEvent,
  PostgresAgentRunner,
} from "./postgres-agent-runner";

type FakeRun = StartedAgentRun & {
  threadId: string;
  agentId: string;
  status: AgentRunStatus;
  stopRequested: boolean;
  expired: boolean;
  events: StoredAgentEvent[];
};

class FakeAgentRunStore implements AgentRunStore {
  private runSequence = 0;
  private eventSequence = 0;
  readonly runs: FakeRun[] = [];
  rejectAppends = false;

  async claimExpiredRun(input: {
    threadId: string;
    ownerToken: string;
    leaseMs: number;
  }) {
    void input.leaseMs;
    const run = this.runs.find(
      (candidate) =>
        candidate.threadId === input.threadId &&
        candidate.expired &&
        (candidate.status === "running" || candidate.status === "finalizing"),
    );
    if (!run) return null;
    run.status = "finalizing";
    run.ownerToken = input.ownerToken;
    run.stopRequested = false;
    run.expired = false;
    return { id: run.id, runId: run.runId, ownerToken: run.ownerToken };
  }

  async startRun(input: {
    threadId: string;
    runId: string;
    agentId: string;
    ownerToken: string;
    leaseMs: number;
  }) {
    void input.leaseMs;
    if (
      this.runs.some(
        (run) =>
          run.threadId === input.threadId &&
          (run.status === "running" || run.status === "finalizing"),
      )
    ) {
      return null;
    }
    const previous = this.runs.filter((run) => run.threadId === input.threadId).at(-1);
    const run: FakeRun = {
      id: String(++this.runSequence),
      runId: input.runId,
      parentRunId: previous?.runId ?? null,
      ownerToken: input.ownerToken,
      threadId: input.threadId,
      agentId: input.agentId,
      status: "running",
      stopRequested: false,
      expired: false,
      events: [],
    };
    this.runs.push(run);
    return {
      id: run.id,
      runId: run.runId,
      parentRunId: run.parentRunId,
      ownerToken: run.ownerToken,
    };
  }

  async appendEvent(input: {
    runRecordId: string;
    ownerToken: string;
    sequence: number;
    event: BaseEvent;
  }) {
    if (this.rejectAppends) return false;
    const run = this.runs.find((candidate) => candidate.id === input.runRecordId);
    if (
      !run ||
      run.ownerToken !== input.ownerToken ||
      (run.status !== "running" && run.status !== "finalizing")
    ) {
      return false;
    }
    run.events.push({
      id: String(++this.eventSequence),
      sequence: input.sequence,
      event: structuredClone(input.event),
    });
    return true;
  }

  async heartbeat(input: {
    runRecordId: string;
    ownerToken: string;
    leaseMs: number;
  }) {
    void input.leaseMs;
    const run = this.runs.find((candidate) => candidate.id === input.runRecordId);
    return run && run.ownerToken === input.ownerToken && run.status === "running"
      ? { stopRequested: run.stopRequested }
      : null;
  }

  async finishRun(input: {
    runRecordId: string;
    ownerToken: string;
    expectedStatus: "running" | "finalizing";
    status: Exclude<AgentRunStatus, "running" | "finalizing">;
  }) {
    const run = this.runs.find((candidate) => candidate.id === input.runRecordId);
    if (
      !run ||
      run.ownerToken !== input.ownerToken ||
      run.status !== input.expectedStatus
    ) {
      return false;
    }
    run.status = input.status;
    run.stopRequested = false;
    return true;
  }

  async requestStop(input: { threadId: string; runId?: string }) {
    const run = this.runs.find(
      (candidate) =>
        candidate.threadId === input.threadId &&
        candidate.status === "running" &&
        (!input.runId || candidate.runId === input.runId),
    );
    if (!run) return null;
    run.stopRequested = true;
    return { runId: run.runId };
  }

  async findActiveRun(threadId: string) {
    const run = this.runs.find(
      (candidate) =>
        candidate.threadId === threadId &&
        !candidate.expired &&
        (candidate.status === "running" || candidate.status === "finalizing"),
    );
    return run ? { runId: run.runId } : null;
  }

  async loadRunEvents(runRecordId: string) {
    return this.runs.find((run) => run.id === runRecordId)?.events ?? [];
  }

  async loadThreadEvents(threadId: string, afterEventId?: string) {
    const after = afterEventId ? Number(afterEventId) : 0;
    return this.runs
      .filter((run) => run.threadId === threadId)
      .flatMap((run) => run.events)
      .filter((event) => Number(event.id) > after)
      .sort((left, right) => Number(left.id) - Number(right.id));
  }

  async deleteThreadHistory(threadId: string) {
    if (await this.findActiveRun(threadId)) {
      return { active: true, deletedRunCount: 0 };
    }
    const matches = this.runs.filter((run) => run.threadId === threadId);
    for (const run of matches) {
      const index = this.runs.indexOf(run);
      this.runs.splice(index, 1);
    }
    return { active: false, deletedRunCount: matches.length };
  }

  seedExpiredRun(threadId: string, events: BaseEvent[]): FakeRun {
    const run: FakeRun = {
      id: String(++this.runSequence),
      runId: "expired-run",
      parentRunId: null,
      ownerToken: crypto.randomUUID(),
      threadId,
      agentId: "test-agent",
      status: "running",
      stopRequested: false,
      expired: true,
      events: events.map((event, sequence) => ({
        id: String(++this.eventSequence),
        sequence,
        event,
      })),
    };
    this.runs.push(run);
    return run;
  }
}

type AgentSubscriber = NonNullable<
  Parameters<AgentRunnerRunRequest["agent"]["runAgent"]>[1]
>;

function runInput(runId = "run-1"): RunAgentInput {
  return {
    threadId: "thread-1",
    runId,
    messages: [{ id: `user-${runId}`, role: "user", content: "Rankings?" }],
    state: {},
    tools: [],
    context: [],
    forwardedProps: {},
  };
}

function requestFor(
  run: (input: RunAgentInput, subscriber: AgentSubscriber) => Promise<void>,
  abort: () => void = () => {},
  input = runInput(),
): AgentRunnerRunRequest {
  const agent = {
    agentId: "test-agent",
    runAgent: run,
    abortRun: abort,
  } as unknown as AgentRunnerRunRequest["agent"];
  return { threadId: input.threadId, input, agent };
}

function successfulEvents(input: RunAgentInput): BaseEvent[] {
  return [
    { type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId },
    {
      type: EventType.TEXT_MESSAGE_START,
      messageId: "assistant-1",
      role: "assistant",
    },
    {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "assistant-1",
      delta: "Top chart",
    },
    { type: EventType.TEXT_MESSAGE_END, messageId: "assistant-1" },
    {
      type: EventType.TOOL_CALL_START,
      toolCallId: "tool-1",
      toolCallName: "getLatestChart",
      parentMessageId: "assistant-1",
    },
    {
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "tool-1",
      delta: "{}",
    },
    { type: EventType.TOOL_CALL_END, toolCallId: "tool-1" },
    {
      type: EventType.TOOL_CALL_RESULT,
      messageId: "tool-result-1",
      toolCallId: "tool-1",
      content: JSON.stringify({ apps: [] }),
      role: "tool",
    },
    { type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId },
  ] as BaseEvent[];
}

async function collect(observable: ReturnType<PostgresAgentRunner["run"]>) {
  return lastValueFrom(observable.pipe(toArray()));
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Condition was not reached.");
}

describe("PostgresAgentRunner", () => {
  it("recognizes only unresolved frontend page tool calls as continuations", async () => {
    const store = new FakeAgentRunStore();
    store.seedExpiredRun("thread-1", [
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "page-tool",
        toolCallName: "setRankingView",
        parentMessageId: "assistant-1",
      },
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "data-tool",
        toolCallName: "getLatestChart",
        parentMessageId: "assistant-1",
      },
    ] as BaseEvent[]);
    const runner = new PostgresAgentRunner({
      store,
      leaseMs: 100,
      heartbeatMs: 20,
      pageToolNames: ["setRankingView"],
    });

    expect(
      await runner.hasPendingPageToolCall("thread-1", "page-tool"),
    ).toBe(true);
    expect(
      await runner.hasPendingPageToolCall("thread-1", "data-tool"),
    ).toBe(false);

    store.seedExpiredRun("thread-1", [
      {
        type: EventType.RUN_STARTED,
        threadId: "thread-1",
        runId: "continuation",
        input: {
          ...runInput("continuation"),
          messages: [
            {
              id: "page-result",
              role: "tool",
              toolCallId: "page-tool",
              content: JSON.stringify({ ok: true }),
            },
          ],
        },
      },
    ] as BaseEvent[]);

    expect(
      await runner.hasPendingPageToolCall("thread-1", "page-tool"),
    ).toBe(false);
  });

  it("persists and replays the full compacted AG-UI event history", async () => {
    const store = new FakeAgentRunStore();
    const runner = new PostgresAgentRunner({
      store,
      leaseMs: 100,
      heartbeatMs: 20,
      connectPollMs: 2,
    });
    const input = runInput();
    const live = await collect(
      runner.run(
        requestFor(async (_input, subscriber) => {
          for (const event of successfulEvents(input)) {
            await subscriber.onEvent?.({ event } as never);
          }
        }, undefined, input),
      ),
    );

    const replayed = await lastValueFrom(
      runner.connect({ threadId: input.threadId }).pipe(toArray()),
    );
    const stored = store.runs[0]?.events.map((row) => row.event) ?? [];

    expect(live.map((event) => event.type)).toEqual(
      successfulEvents(input).map((event) => event.type),
    );
    expect(replayed).toEqual(compactEvents(stored));
    expect(store.runs[0]?.status).toBe("completed");
    expect(
      (stored.find((event) => event.type === EventType.RUN_STARTED) as RunStartedEvent)
        .input?.messages,
    ).toEqual(input.messages);
  });

  it("deletes the complete replay projection after a run finishes", async () => {
    const store = new FakeAgentRunStore();
    const runner = new PostgresAgentRunner({
      store,
      leaseMs: 100,
      heartbeatMs: 20,
    });
    const input = runInput();
    await collect(
      runner.run(
        requestFor(async (_input, subscriber) => {
          for (const event of successfulEvents(input)) {
            await subscriber.onEvent?.({ event } as never);
          }
        }, undefined, input),
      ),
    );

    expect(await runner.deleteThreadHistory(input.threadId)).toEqual({
      active: false,
      deletedRunCount: 1,
    });
    expect(await store.loadThreadEvents(input.threadId)).toEqual([]);
  });

  it("refuses to delete replay history while the thread is running", async () => {
    const store = new FakeAgentRunStore();
    const runner = new PostgresAgentRunner({
      store,
      leaseMs: 100,
      heartbeatMs: 20,
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const input = runInput();
    const run = collect(
      runner.run(
        requestFor(async (_input, subscriber) => {
          await subscriber.onEvent?.({
            event: successfulEvents(input)[0],
          } as never);
          await blocked;
          await subscriber.onEvent?.({
            event: successfulEvents(input).at(-1),
          } as never);
        }, undefined, input),
      ),
    );
    await waitUntil(() => store.runs[0]?.status === "running");

    expect(await runner.deleteThreadHistory(input.threadId)).toEqual({
      active: true,
      deletedRunCount: 0,
    });
    expect(store.runs).toHaveLength(1);

    release();
    await run;
  });

  it("never exposes or persists internal reasoning events", async () => {
    const store = new FakeAgentRunStore();
    const runner = new PostgresAgentRunner({
      store,
      leaseMs: 100,
      heartbeatMs: 20,
      connectPollMs: 2,
    });
    const input = runInput();
    const reasoning = [
      { type: "THINKING_START", title: "Legacy thought" },
      {
        type: "THINKING_TEXT_MESSAGE_START",
        messageId: "thinking-legacy",
      },
      {
        type: "THINKING_TEXT_MESSAGE_CONTENT",
        messageId: "thinking-legacy",
        delta: "legacy private chain of thought",
      },
      {
        type: "THINKING_TEXT_MESSAGE_END",
        messageId: "thinking-legacy",
      },
      { type: "THINKING_END" },
      { type: EventType.REASONING_START, messageId: "reasoning-1" },
      {
        type: EventType.REASONING_MESSAGE_START,
        messageId: "reasoning-1",
        role: "reasoning",
      },
      {
        type: EventType.REASONING_MESSAGE_CONTENT,
        messageId: "reasoning-1",
        delta: "private chain of thought",
      },
      { type: EventType.REASONING_MESSAGE_END, messageId: "reasoning-1" },
      {
        type: EventType.REASONING_MESSAGE_CHUNK,
        messageId: "reasoning-chunk",
        delta: "private reasoning chunk",
      },
      { type: EventType.REASONING_END, messageId: "reasoning-1" },
      {
        type: EventType.REASONING_ENCRYPTED_VALUE,
        encryptedValue: "encrypted-private-reasoning",
      },
    ] as BaseEvent[];
    const emitted = [
      successfulEvents(input)[0]!,
      ...reasoning,
      ...successfulEvents(input).slice(1),
    ];

    const live = await collect(
      runner.run(
        requestFor(async (_input, subscriber) => {
          for (const event of emitted) {
            await subscriber.onEvent?.({ event } as never);
          }
        }, undefined, input),
      ),
    );
    const stored = store.runs[0]?.events.map((row) => row.event) ?? [];
    const replayed = await lastValueFrom(
      runner.connect({ threadId: input.threadId }).pipe(toArray()),
    );

    expect(reasoning.every((event) => !isClientVisibleAgentEvent(event))).toBe(true);
    for (const events of [live, stored, replayed]) {
      expect(events.some((event) => event.type === EventType.REASONING_START)).toBe(
        false,
      );
      expect(JSON.stringify(events)).not.toContain("private chain of thought");
      expect(JSON.stringify(events)).not.toContain("private reasoning chunk");
      expect(JSON.stringify(events)).not.toContain("encrypted-private-reasoning");
      expect(
        events.some((event) => event.type === EventType.TEXT_MESSAGE_CONTENT),
      ).toBe(true);
    }
  });

  it("filters reasoning from legacy persisted history", async () => {
    const store = new FakeAgentRunStore();
    store.seedExpiredRun("legacy-thread", [
      {
        type: EventType.RUN_STARTED,
        threadId: "legacy-thread",
        runId: "legacy-run",
      },
      {
        type: EventType.REASONING_MESSAGE_CONTENT,
        messageId: "reasoning-legacy",
        delta: "legacy private reasoning",
      },
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "assistant-legacy",
        role: "assistant",
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "assistant-legacy",
        delta: "Verified answer",
      },
      { type: EventType.TEXT_MESSAGE_END, messageId: "assistant-legacy" },
      {
        type: EventType.RUN_FINISHED,
        threadId: "legacy-thread",
        runId: "legacy-run",
      },
    ] as BaseEvent[]);
    const runner = new PostgresAgentRunner({
      store,
      leaseMs: 100,
      heartbeatMs: 20,
      connectPollMs: 2,
    });

    const replayed = await lastValueFrom(
      runner.connect({ threadId: "legacy-thread" }).pipe(toArray()),
    );

    expect(JSON.stringify(replayed)).not.toContain("legacy private reasoning");
    expect(JSON.stringify(replayed)).toContain("Verified answer");
  });

  it("persists agent failures as a terminal failed run", async () => {
    const store = new FakeAgentRunStore();
    const runner = new PostgresAgentRunner({
      store,
      leaseMs: 100,
      heartbeatMs: 20,
    });
    const errorLog = spyOn(console, "error").mockImplementation(() => {});

    try {
      const events = await collect(
        runner.run(
          requestFor(async (input, subscriber) => {
            await subscriber.onEvent?.({
              event: {
                type: EventType.RUN_STARTED,
                threadId: input.threadId,
                runId: input.runId,
              },
            } as never);
            throw new Error("provider failed");
          }),
        ),
      );

      expect(events.some((event) => event.type === EventType.RUN_ERROR)).toBe(true);
      expect(events.at(-1)?.type).toBe(EventType.RUN_ERROR);
      expect(store.runs[0]?.status).toBe("failed");
    } finally {
      errorLog.mockRestore();
    }
  });

  it("serializes a thread across runner instances", async () => {
    const store = new FakeAgentRunStore();
    const runnerA = new PostgresAgentRunner({
      store,
      leaseMs: 100,
      heartbeatMs: 20,
    });
    const runnerB = new PostgresAgentRunner({
      store,
      leaseMs: 100,
      heartbeatMs: 20,
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = collect(
      runnerA.run(
        requestFor(async (_input, subscriber) => {
          await subscriber.onEvent?.({
            event: {
              type: EventType.RUN_STARTED,
              threadId: "thread-1",
              runId: "run-1",
            },
          } as never);
          await blocked;
          await subscriber.onEvent?.({
            event: {
              type: EventType.RUN_FINISHED,
              threadId: "thread-1",
              runId: "run-1",
            },
          } as never);
        }),
      ),
    );
    await waitUntil(() => store.runs[0]?.status === "running");

    await expect(
      collect(
        runnerB.run(
          requestFor(async () => {}, undefined, runInput("run-2")),
        ),
      ),
    ).rejects.toThrow("Thread already running");

    release();
    await first;
  });

  it("propagates stop requests across runner instances", async () => {
    const store = new FakeAgentRunStore();
    const runnerA = new PostgresAgentRunner({
      store,
      leaseMs: 100,
      heartbeatMs: 5,
    });
    const runnerB = new PostgresAgentRunner({
      store,
      leaseMs: 100,
      heartbeatMs: 5,
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = collect(
      runnerA.run(
        requestFor(
          async (_input, subscriber) => {
            await subscriber.onEvent?.({
              event: {
                type: EventType.RUN_STARTED,
                threadId: "thread-1",
                runId: "run-1",
              },
            } as never);
            await blocked;
          },
          () => release(),
        ),
      ),
    );
    await waitUntil(() => store.runs[0]?.status === "running");

    expect(await runnerB.stop({ threadId: "thread-1", runId: "run-1" })).toBe(
      true,
    );
    const events = await run;

    expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
    expect(store.runs[0]?.status).toBe("stopped");
  });

  it("reconnects to an in-flight run from another instance", async () => {
    const store = new FakeAgentRunStore();
    const runnerA = new PostgresAgentRunner({
      store,
      leaseMs: 100,
      heartbeatMs: 20,
      connectPollMs: 2,
    });
    const runnerB = new PostgresAgentRunner({
      store,
      leaseMs: 100,
      heartbeatMs: 20,
      connectPollMs: 2,
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = collect(
      runnerA.run(
        requestFor(async (_input, subscriber) => {
          for (const event of successfulEvents(runInput()).slice(0, 3)) {
            await subscriber.onEvent?.({ event } as never);
          }
          await blocked;
          for (const event of successfulEvents(runInput()).slice(3)) {
            await subscriber.onEvent?.({ event } as never);
          }
        }),
      ),
    );
    await waitUntil(() => (store.runs[0]?.events.length ?? 0) >= 3);

    const reconnected = lastValueFrom(
      runnerB.connect({ threadId: "thread-1" }).pipe(toArray()),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    release();

    await run;
    const replayed = await reconnected;
    expect(replayed.some((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)).toBe(
      true,
    );
    expect(replayed.at(-1)?.type).toBe(EventType.RUN_FINISHED);
  });

  it("continues an assistant message that was compacted during reconnect", async () => {
    const store = new FakeAgentRunStore();
    const runnerA = new PostgresAgentRunner({
      store,
      leaseMs: 100,
      heartbeatMs: 20,
      connectPollMs: 2,
    });
    const runnerB = new PostgresAgentRunner({
      store,
      leaseMs: 100,
      heartbeatMs: 20,
      connectPollMs: 2,
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const input = runInput();
    const run = collect(
      runnerA.run(
        requestFor(async (_input, subscriber) => {
          await subscriber.onEvent?.({
            event: {
              type: EventType.RUN_STARTED,
              threadId: input.threadId,
              runId: input.runId,
            },
          } as never);
          await subscriber.onEvent?.({
            event: {
              type: EventType.TEXT_MESSAGE_START,
              messageId: "assistant-streaming",
              role: "assistant",
            },
          } as never);
          await subscriber.onEvent?.({
            event: {
              type: EventType.TEXT_MESSAGE_CONTENT,
              messageId: "assistant-streaming",
              delta: "Top ",
            },
          } as never);
          await blocked;
          await subscriber.onEvent?.({
            event: {
              type: EventType.TEXT_MESSAGE_CONTENT,
              messageId: "assistant-streaming",
              delta: "chart",
            },
          } as never);
          await subscriber.onEvent?.({
            event: {
              type: EventType.TEXT_MESSAGE_END,
              messageId: "assistant-streaming",
            },
          } as never);
          await subscriber.onEvent?.({
            event: {
              type: EventType.RUN_FINISHED,
              threadId: input.threadId,
              runId: input.runId,
            },
          } as never);
        }, undefined, input),
      ),
    );
    await waitUntil(() => (store.runs[0]?.events.length ?? 0) >= 3);

    const reconnected = lastValueFrom(
      runnerB.connect({ threadId: input.threadId }).pipe(toArray()),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    release();

    await run;
    const replayed = await reconnected;
    expect(replayed).toContainEqual({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "assistant-streaming",
      delta: "chart",
    });
    expect(replayed).toContainEqual({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "assistant-streaming",
    });
  });

  it("terminalizes an expired run before replaying it", async () => {
    const store = new FakeAgentRunStore();
    const expired = store.seedExpiredRun("thread-1", [
      {
        type: EventType.RUN_STARTED,
        threadId: "thread-1",
        runId: "expired-run",
      },
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "assistant-expired",
        role: "assistant",
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "assistant-expired",
        delta: "Partial",
      },
    ] as BaseEvent[]);
    const runner = new PostgresAgentRunner({
      store,
      leaseMs: 100,
      heartbeatMs: 20,
      connectPollMs: 2,
    });

    const replayed = await lastValueFrom(
      runner.connect({ threadId: "thread-1" }).pipe(toArray()),
    );

    expect(expired.status).toBe("interrupted");
    expect(expired.events.map((row) => row.event.type)).toContain(
      EventType.RUN_ERROR,
    );
    expect(replayed.some((event) => event.type === EventType.RUN_ERROR)).toBe(
      true,
    );
  });
});
