import {
  EventType,
  type BaseEvent,
  type RunErrorEvent,
} from "@ag-ui/core";
import type { RequestContext } from "@mastra/core/request-context";
import {
  EMPTY,
  type Observable,
  catchError,
  finalize,
  fromEvent,
  of,
  takeUntil,
} from "rxjs";

import { logError } from "../logging";

export const COPILOT_ABORT_SIGNAL_KEY = "assistant.abort-signal";

type RawRequestContext = Pick<
  RequestContext,
  "getRaw" | "setRaw" | "deleteRaw"
>;

type RunLifecycleAgent<TInput> = {
  run: (input: TInput) => Observable<BaseEvent>;
  abortRun: () => void;
};

function optionsWithAbortSignal(
  options: unknown,
  requestContext: RawRequestContext,
): Record<string, unknown> | undefined {
  const signal = requestContext.getRaw(COPILOT_ABORT_SIGNAL_KEY);
  if (!(signal instanceof AbortSignal)) {
    return options && typeof options === "object"
      ? (options as Record<string, unknown>)
      : undefined;
  }

  return {
    ...(options && typeof options === "object" ? options : {}),
    abortSignal: signal,
  };
}

/**
 * Gives the AG-UI adapter a request-local Mastra agent without mutating the
 * shared registry instance. The adapter does not forward abortSignal itself,
 * so inject it into every local stream/resume invocation at this boundary.
 */
export function bindMastraRunAbortSignal<TAgent extends object>(
  agent: TAgent,
  requestContext: RawRequestContext,
): TAgent {
  const methods = new Map<PropertyKey, unknown>();

  return new Proxy(agent, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;

      const cached = methods.get(property);
      if (cached) return cached;

      const method =
        property === "stream" || property === "resumeStream"
          ? (...args: unknown[]) =>
              Reflect.apply(value, target, [
                args[0],
                optionsWithAbortSignal(args[1], requestContext),
                ...args.slice(2),
              ])
          : value.bind(target);
      methods.set(property, method);
      return method;
    },
  });
}

function runErrorEvent(): RunErrorEvent {
  return {
    type: EventType.RUN_ERROR,
    message: "The assistant run did not complete.",
    code: "MASTRA_RUN_FAILED",
  };
}

/**
 * Bridges two lifecycle gaps in @ag-ui/mastra 1.1.2:
 * - its abortRun implementation does not end the AG-UI observable;
 * - adapter errors terminate the RxJS channel without an AG-UI RUN_ERROR.
 *
 * bindMastraRunAbortSignal forwards the same signal into the underlying Mastra
 * stream. takeUntil closes the adapter stream even if a provider ignores
 * cancellation; PostgresAgentRunner then supplies the appropriate terminal
 * AG-UI event. Keeping both shims at this boundary makes them safe to remove
 * when upstream ships the same protocol guarantees.
 */
export function attachMastraRunLifecycle<TInput>(
  agent: RunLifecycleAgent<TInput>,
  requestContext: RawRequestContext,
): RunLifecycleAgent<TInput> {
  const baseRun = agent.run.bind(agent);
  const baseAbortRun = agent.abortRun.bind(agent);
  let activeController: AbortController | null = null;

  agent.run = (input) => {
    activeController?.abort();
    const controller = new AbortController();
    activeController = controller;
    requestContext.setRaw(COPILOT_ABORT_SIGNAL_KEY, controller.signal);

    return baseRun(input).pipe(
      takeUntil(fromEvent(controller.signal, "abort")),
      catchError((error: unknown) => {
        if (
          controller.signal.aborted ||
          (error instanceof DOMException && error.name === "AbortError")
        ) {
          return EMPTY;
        }
        logError("mastra_ag_ui_run_failed", error);
        return of(runErrorEvent() as BaseEvent);
      }),
      finalize(() => {
        if (activeController === controller) {
          activeController = null;
          requestContext.deleteRaw(COPILOT_ABORT_SIGNAL_KEY);
        }
      }),
    );
  };

  agent.abortRun = () => {
    activeController?.abort();
    baseAbortRun();
  };

  return agent;
}
