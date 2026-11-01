import { randomUUID } from "node:crypto";

import { ASSISTANT_PAGE_TOOL_NAMES } from "@northwind/product/assistant-contracts";
import {
  EventType,
  compactEvents,
  type BaseEvent,
  type RunStartedEvent,
} from "@ag-ui/client";
import {
  AgentRunner,
  finalizeRunEvents,
  type AgentRunnerConnectRequest,
  type AgentRunnerIsRunningRequest,
  type AgentRunnerRunRequest,
  type AgentRunnerStopRequest,
} from "@copilotkit/runtime/v2";
import { Observable, ReplaySubject } from "rxjs";

import { logError } from "../logging";
import {
  type DeleteAgentThreadHistoryResult,
  PostgresAgentRunStore,
  type AgentRunStatus,
  type AgentRunStore,
  type StartedAgentRun,
  type StoredAgentEvent,
} from "./postgres-agent-run-store";

const DEFAULT_LEASE_MS = 15_000;
const DEFAULT_HEARTBEAT_MS = 1_000;
const DEFAULT_CONNECT_POLL_MS = 250;
const INTERRUPTED_RUN_MESSAGE =
  "The previous assistant response was interrupted before it completed.";
const FAILED_RUN_MESSAGE = "The assistant run did not complete.";
const INTERNAL_AGENT_EVENT_TYPES = new Set<string>([
  // AG-UI 1.0 removed the THINKING_* events; runs stored before the upgrade still contain them.
  "THINKING_START",
  "THINKING_TEXT_MESSAGE_START",
  "THINKING_TEXT_MESSAGE_CONTENT",
  "THINKING_TEXT_MESSAGE_END",
  "THINKING_END",
  EventType.REASONING_START,
  EventType.REASONING_MESSAGE_START,
  EventType.REASONING_MESSAGE_CONTENT,
  EventType.REASONING_MESSAGE_END,
  EventType.REASONING_MESSAGE_CHUNK,
  EventType.REASONING_END,
  EventType.REASONING_ENCRYPTED_VALUE,
]);

/** Internal model reasoning is neither sent to clients nor stored as chat history. */
export function isClientVisibleAgentEvent(event: BaseEvent): boolean {
  return !INTERNAL_AGENT_EVENT_TYPES.has(event.type);
}

type FinalStatus = Exclude<AgentRunStatus, "running" | "finalizing">;

type ActiveRun = {
  record: StartedAgentRun;
  agent: AgentRunnerRunRequest["agent"];
  stopRequested: boolean;
  ownershipLost: boolean;
  storeFailed: boolean;
  abortIssued: boolean;
  heartbeatTimer: ReturnType<typeof setTimeout> | null;
};

type PostgresAgentRunnerOptions = {
  store?: AgentRunStore;
  leaseMs?: number;
  heartbeatMs?: number;
  connectPollMs?: number;
  /** Frontend page tools whose calls a later run may answer; defaults to the product contract. */
  pageToolNames?: readonly string[];
};

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function eventMessageId(event: BaseEvent): string | null {
  if (!("messageId" in event)) return null;
  return typeof event.messageId === "string" ? event.messageId : null;
}

function historicMessageIds(events: readonly StoredAgentEvent[]): Set<string> {
  const ids = new Set<string>();
  for (const { event } of events) {
    const messageId = eventMessageId(event);
    if (messageId) ids.add(messageId);
    if (event.type !== EventType.RUN_STARTED) continue;
    for (const message of (event as RunStartedEvent).input?.messages ?? []) {
      ids.add(message.id);
    }
  }
  return ids;
}

function statusAfter(events: readonly BaseEvent[], stopped: boolean): FinalStatus {
  if (stopped) return "stopped";
  return events.some((event) => event.type === EventType.RUN_ERROR)
    ? "failed"
    : "completed";
}

/**
 * Durable, horizontally safe CopilotKit runner backed by the application's
 * existing PostgreSQL database.
 *
 * Completed and in-flight events are persisted individually so a reconnect on
 * another API instance can replay the same AG-UI stream. A renewable lease
 * recovers runs after process loss; stop requests are visible across instances.
 */
export class PostgresAgentRunner extends AgentRunner {
  private readonly store: AgentRunStore;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly connectPollMs: number;
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly runTasks = new Set<Promise<void>>();
  private readonly pageToolNames: ReadonlySet<string>;

  constructor(options: PostgresAgentRunnerOptions = {}) {
    super();
    this.store = options.store ?? new PostgresAgentRunStore();
    this.pageToolNames = new Set(options.pageToolNames ?? ASSISTANT_PAGE_TOOL_NAMES);
    this.leaseMs = positiveInteger(options.leaseMs ?? DEFAULT_LEASE_MS, "leaseMs");
    this.heartbeatMs = positiveInteger(
      options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
      "heartbeatMs",
    );
    this.connectPollMs = positiveInteger(
      options.connectPollMs ?? DEFAULT_CONNECT_POLL_MS,
      "connectPollMs",
    );
    if (this.heartbeatMs >= this.leaseMs) {
      throw new Error("heartbeatMs must be shorter than leaseMs.");
    }
  }

  run(request: AgentRunnerRunRequest): Observable<BaseEvent> {
    if (this.activeRuns.has(request.threadId)) {
      throw new Error("Thread already running");
    }

    const subject = new ReplaySubject<BaseEvent>(Infinity);
    const task = this.executeRun(request, subject)
      .catch((error: unknown) => {
        if (error instanceof Error && error.message === "Thread already running") {
          subject.error(error);
          return;
        }
        this.logFailure("start", error);
        subject.error(new Error("Assistant persistence is unavailable."));
      })
      .finally(() => this.runTasks.delete(task));
    this.runTasks.add(task);
    return subject.asObservable();
  }

  connect(request: AgentRunnerConnectRequest): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      let cancelled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let wake: (() => void) | null = null;

      const waitForPoll = () =>
        new Promise<void>((resolve) => {
          wake = resolve;
          timer = setTimeout(resolve, this.connectPollMs);
        }).finally(() => {
          timer = null;
          wake = null;
        });

      void (async () => {
        await this.finalizeExpiredRun(request.threadId);
        const historic = await this.store.loadThreadEvents(request.threadId);
        let cursor = historic.at(-1)?.id;

        const visibleHistory = historic.filter((row) =>
          isClientVisibleAgentEvent(row.event),
        );
        for (const event of compactEvents(visibleHistory.map((row) => row.event))) {
          if (cancelled) return;
          subscriber.next(event);
        }

        const emitRows = (rows: readonly StoredAgentEvent[]) => {
          for (const row of rows) {
            cursor = row.id;
            if (!isClientVisibleAgentEvent(row.event)) continue;
            subscriber.next(row.event);
          }
        };

        for (;;) {
          if (cancelled) return;
          emitRows(await this.store.loadThreadEvents(request.threadId, cursor));

          const active = await this.store.findActiveRun(request.threadId);
          if (active) {
            await waitForPoll();
            continue;
          }

          // If a process died, turn its expired open stream into a terminal
          // history entry before this connection completes.
          await this.finalizeExpiredRun(request.threadId);
          emitRows(await this.store.loadThreadEvents(request.threadId, cursor));
          if (!(await this.store.findActiveRun(request.threadId))) {
            subscriber.complete();
            return;
          }
        }
      })().catch((error: unknown) => {
        if (cancelled) return;
        this.logFailure("connect", error);
        subscriber.error(new Error("Assistant history is unavailable."));
      });

      return () => {
        cancelled = true;
        if (timer) clearTimeout(timer);
        wake?.();
      };
    });
  }

  async isRunning(request: AgentRunnerIsRunningRequest): Promise<boolean> {
    await this.finalizeExpiredRun(request.threadId);
    return (await this.store.findActiveRun(request.threadId)) !== null;
  }

  async hasPendingPageToolCall(
    threadId: string,
    toolCallId: string,
  ): Promise<boolean> {
    const events = await this.store.loadThreadEvents(threadId);
    let pending = false;

    for (const { event } of events) {
      if (
        event.type === EventType.TOOL_CALL_START &&
        event.toolCallId === toolCallId &&
        typeof event.toolCallName === "string" &&
        this.pageToolNames.has(event.toolCallName)
      ) {
        pending = true;
        continue;
      }
      if (
        event.type === EventType.TOOL_CALL_RESULT &&
        event.toolCallId === toolCallId
      ) {
        pending = false;
        continue;
      }
      if (event.type !== EventType.RUN_STARTED) continue;
      const input = (event as RunStartedEvent).input;
      if (
        input?.messages?.some(
          (message) =>
            message.role === "tool" && message.toolCallId === toolCallId,
        )
      ) {
        pending = false;
      }
    }

    return pending;
  }

  /**
   * Removes the AG-UI replay projection for a conversation. Mastra messages
   * remain the canonical history and are deleted separately through Memory.
   */
  async deleteThreadHistory(
    threadId: string,
  ): Promise<DeleteAgentThreadHistoryResult> {
    if (this.activeRuns.has(threadId)) {
      return { active: true, deletedRunCount: 0 };
    }
    await this.finalizeExpiredRun(threadId);
    if (this.activeRuns.has(threadId)) {
      return { active: true, deletedRunCount: 0 };
    }
    return this.store.deleteThreadHistory(threadId);
  }

  async stop(request: AgentRunnerStopRequest): Promise<boolean | undefined> {
    await this.finalizeExpiredRun(request.threadId);
    const stopped = await this.store.requestStop({
      threadId: request.threadId,
      ...(request.runId ? { runId: request.runId } : {}),
    });
    if (!stopped) return false;

    const active = this.activeRuns.get(request.threadId);
    if (active && active.record.runId === stopped.runId) {
      active.stopRequested = true;
      this.abort(active, "stop");
    }
    return true;
  }

  async shutdown(timeoutMs = 5_000): Promise<void> {
    const active = [...this.activeRuns.entries()];
    await Promise.allSettled(
      active.map(async ([threadId, run]) => {
        await this.store.requestStop({ threadId, runId: run.record.runId });
        run.stopRequested = true;
        this.abort(run, "shutdown");
      }),
    );
    if (this.runTasks.size === 0) return;
    await Promise.race([
      Promise.allSettled([...this.runTasks]),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  private async executeRun(
    request: AgentRunnerRunRequest,
    subject: ReplaySubject<BaseEvent>,
  ): Promise<void> {
    await this.finalizeExpiredRun(request.threadId);
    const previousEvents = await this.store.loadThreadEvents(request.threadId);
    const previousMessageIds = historicMessageIds(previousEvents);
    const ownerToken = randomUUID();
    const record = await this.store.startRun({
      threadId: request.threadId,
      runId: request.input.runId,
      agentId: request.agent.agentId ?? "default",
      ownerToken,
      leaseMs: this.leaseMs,
    });
    if (!record) throw new Error("Thread already running");

    const active: ActiveRun = {
      record,
      agent: request.agent,
      stopRequested: false,
      ownershipLost: false,
      storeFailed: false,
      abortIssued: false,
      heartbeatTimer: null,
    };
    this.activeRuns.set(request.threadId, active);

    try {
      const events: BaseEvent[] = [];
      let sequence = 0;
      let persistenceFailure: unknown;
      let persistenceQueue = Promise.resolve();

      const persist = (event: BaseEvent) => {
        events.push(event);
        subject.next(event);
        const eventSequence = sequence++;
        if (persistenceFailure || active.ownershipLost) return;
        persistenceQueue = persistenceQueue
          .then(async () => {
            const appended = await this.store.appendEvent({
              runRecordId: record.id,
              ownerToken: record.ownerToken,
              sequence: eventSequence,
              event,
            });
            if (!appended) throw new Error("AG-UI run lease was lost.");
          })
          .catch((error: unknown) => {
            persistenceFailure ??= error;
            active.storeFailed = true;
            this.abort(active, "persist");
          });
      };

      const finalize = (error?: unknown) => {
        const appended = finalizeRunEvents(events, {
          stopRequested: active.stopRequested,
          ...(error !== undefined && !active.stopRequested
            ? { interruptionMessage: FAILED_RUN_MESSAGE }
            : {}),
        });
        for (const event of appended) {
          subject.next(event);
          const eventSequence = sequence++;
          if (persistenceFailure || active.ownershipLost) continue;
          persistenceQueue = persistenceQueue
            .then(async () => {
              const stored = await this.store.appendEvent({
                runRecordId: record.id,
                ownerToken: record.ownerToken,
                sequence: eventSequence,
                event,
              });
              if (!stored) throw new Error("AG-UI run lease was lost.");
            })
            .catch((storeError: unknown) => {
              persistenceFailure ??= storeError;
              active.storeFailed = true;
            });
        }
      };

      this.scheduleHeartbeat(request.threadId, active, (error) => {
        persistenceFailure ??= error;
        active.storeFailed = true;
      });

      let runError: unknown;
      try {
        await request.agent.runAgent(request.input, {
          onEvent: ({ event }) => {
            let processed = event;
            if (event.type === EventType.RUN_STARTED) {
              const started = event as RunStartedEvent;
              if (!started.input) {
                const messages = request.input.messages?.filter(
                  (message) => !previousMessageIds.has(message.id),
                );
                processed = {
                  ...started,
                  input: {
                    ...request.input,
                    ...(messages ? { messages } : {}),
                  },
                } as RunStartedEvent;
              }
            }
            if (!isClientVisibleAgentEvent(processed)) return;
            persist(processed);
          },
        });
        await persistenceQueue;
        if (persistenceFailure) throw persistenceFailure;
      } catch (error) {
        runError = error;
        if (!active.stopRequested && !active.ownershipLost) {
          this.logFailure("run", error);
        }
      }

      finalize(runError);
      await persistenceQueue;
      const status = statusAfter(events, active.stopRequested);
      if (!active.ownershipLost && !persistenceFailure) {
        try {
          const finished = await this.store.finishRun({
            runRecordId: record.id,
            ownerToken: record.ownerToken,
            expectedStatus: "running",
            status,
          });
          if (!finished) throw new Error("AG-UI run ownership was lost.");
        } catch (error) {
          this.logFailure("finish", error);
        }
      }

      subject.complete();
    } finally {
      if (active.heartbeatTimer) clearTimeout(active.heartbeatTimer);
      if (this.activeRuns.get(request.threadId) === active) {
        this.activeRuns.delete(request.threadId);
      }
    }
  }

  private scheduleHeartbeat(
    threadId: string,
    active: ActiveRun,
    onFailure: (error: unknown) => void,
  ): void {
    const beat = async () => {
      if (this.activeRuns.get(threadId) !== active || active.storeFailed) return;
      try {
        const heartbeat = await this.store.heartbeat({
          runRecordId: active.record.id,
          ownerToken: active.record.ownerToken,
          leaseMs: this.leaseMs,
        });
        if (!heartbeat) {
          active.ownershipLost = true;
          this.abort(active, "lease");
          return;
        }
        if (heartbeat.stopRequested) {
          active.stopRequested = true;
          this.abort(active, "stop");
        }
      } catch (error) {
        onFailure(error);
        this.abort(active, "heartbeat");
      }
      if (this.activeRuns.get(threadId) === active && !active.storeFailed) {
        active.heartbeatTimer = setTimeout(beat, this.heartbeatMs);
      }
    };
    active.heartbeatTimer = setTimeout(beat, this.heartbeatMs);
  }

  private abort(active: ActiveRun, stage: string): void {
    if (active.abortIssued) return;
    active.abortIssued = true;
    try {
      active.agent.abortRun();
    } catch (error) {
      this.logFailure(`${stage}_abort`, error);
    }
  }

  private async finalizeExpiredRun(threadId: string): Promise<void> {
    const ownerToken = randomUUID();
    const claimed = await this.store.claimExpiredRun({
      threadId,
      ownerToken,
      leaseMs: this.leaseMs,
    });
    if (!claimed) return;

    try {
      const stored = await this.store.loadRunEvents(claimed.id);
      const events = stored.map((row) => row.event);
      const hadFinished = events.some(
        (event) => event.type === EventType.RUN_FINISHED,
      );
      const hadError = events.some((event) => event.type === EventType.RUN_ERROR);
      let sequence = (stored.at(-1)?.sequence ?? -1) + 1;
      for (const event of finalizeRunEvents(events, {
        interruptionMessage: INTERRUPTED_RUN_MESSAGE,
      })) {
        const appended = await this.store.appendEvent({
          runRecordId: claimed.id,
          ownerToken: claimed.ownerToken,
          sequence: sequence++,
          event,
        });
        if (!appended) throw new Error("Expired AG-UI run ownership was lost.");
      }
      const finished = await this.store.finishRun({
        runRecordId: claimed.id,
        ownerToken: claimed.ownerToken,
        expectedStatus: "finalizing",
        status: hadFinished ? "completed" : hadError ? "failed" : "interrupted",
      });
      if (!finished) throw new Error("Expired AG-UI run ownership was lost.");
    } catch (error) {
      this.logFailure("recover", error);
      // The finalizing lease expires and another request can retry recovery.
    }
  }

  private logFailure(stage: string, error: unknown): void {
    logError("ag_ui_runner_error", error, { stage });
  }
}
