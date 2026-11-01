import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

import { EventType } from "@ag-ui/core";
import { AgentRunner } from "@copilotkit/runtime/v2";
import { catchError, from, mergeMap, throwError } from "rxjs";

import { logError } from "../logging";

export const copilotUserContext = new AsyncLocalStorage<string>();
export const assistantRunQuotaContext = new AsyncLocalStorage<{
  refund: () => Promise<void>;
}>();

export function scopedAssistantThreadId(
  userId: string,
  threadId: string,
): string {
  const digest = createHash("sha256")
    .update(userId)
    .update("\0")
    .update(threadId)
    .digest("hex");
  return `user-thread:${digest}`;
}

type RunnerAgent = Parameters<AgentRunner["run"]>[0]["agent"];

function refundableAgent(agent: RunnerAgent, refund: () => Promise<void>) {
  let aborted = false;
  let refundPromise: Promise<void> | null = null;
  const refundOnce = () => {
    refundPromise ??= refund().catch((error) => {
      logError("assistant_quota_refund_failed", error);
    });
    return refundPromise;
  };

  const wrapped = new Proxy(agent, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;

      if (property === "abortRun") {
        return (...args: unknown[]) => {
          aborted = true;
          const result = Reflect.apply(value, target, args);
          void refundOnce();
          return result;
        };
      }
      if (property !== "runAgent") return value.bind(target);

      return async (...args: unknown[]) => {
        let failed = false;
        const subscriber = args[1] as
          | {
              onEvent?: (input: { event?: { type?: string } }) => unknown;
            }
          | undefined;
        const originalOnEvent = subscriber?.onEvent;
        const wrappedSubscriber = subscriber
          ? {
              ...subscriber,
              onEvent: (input: { event?: { type?: string } }) => {
                if (input.event?.type === EventType.RUN_ERROR) failed = true;
                return originalOnEvent?.(input);
              },
            }
          : subscriber;

        try {
          return await Reflect.apply(value, target, [
            args[0],
            wrappedSubscriber,
            ...args.slice(2),
          ]);
        } catch (error) {
          failed = true;
          throw error;
        } finally {
          if (failed || aborted) await refundOnce();
        }
      };
    },
  }) as RunnerAgent;

  return { wrapped, refundOnce };
}

/**
 * Isolates CopilotKit runner storage by authenticated user.
 *
 * The original AG-UI thread id remains in RunAgentInput and emitted events;
 * only the runner's internal storage key is scoped. The non-reversible key
 * prevents event rows from exposing either the user id or visible thread id.
 */
export class UserScopedAgentRunner extends AgentRunner {
  constructor(private readonly delegate: AgentRunner) {
    super();
  }

  private scopedThreadId(threadId: string): string {
    const userId = copilotUserContext.getStore();
    if (!userId) throw new Error("Authenticated Copilot user context is required.");
    return scopedAssistantThreadId(userId, threadId);
  }

  run(
    request: Parameters<AgentRunner["run"]>[0],
  ): ReturnType<AgentRunner["run"]> {
    const threadId = this.scopedThreadId(request.threadId);
    const quota = assistantRunQuotaContext.getStore();
    if (!quota) return this.delegate.run({ ...request, threadId });

    const { wrapped, refundOnce } = refundableAgent(request.agent, quota.refund);
    try {
      return this.delegate.run({ ...request, threadId, agent: wrapped }).pipe(
        catchError((error: unknown) =>
          from(refundOnce()).pipe(
            mergeMap(() => throwError(() => error)),
          ),
        ),
      );
    } catch (error) {
      void refundOnce();
      throw error;
    }
  }

  connect(
    request: Parameters<AgentRunner["connect"]>[0],
  ): ReturnType<AgentRunner["connect"]> {
    return this.delegate.connect({
      ...request,
      threadId: this.scopedThreadId(request.threadId),
    });
  }

  isRunning(
    request: Parameters<AgentRunner["isRunning"]>[0],
  ): ReturnType<AgentRunner["isRunning"]> {
    return this.delegate.isRunning({
      ...request,
      threadId: this.scopedThreadId(request.threadId),
    });
  }

  stop(
    request: Parameters<AgentRunner["stop"]>[0],
  ): ReturnType<AgentRunner["stop"]> {
    return this.delegate.stop({
      ...request,
      threadId: this.scopedThreadId(request.threadId),
    });
  }
}
